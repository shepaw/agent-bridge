/**
 * Manages a long-lived ACP agent subprocess and ClientConnection.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';

import * as acp from '@agentclientprotocol/sdk';
import { TaskCancelledError } from 'shepaw-acp-sdk';
import type { ModelsListResult, ModelsSetCurrentResult, ModesListResult, ModesSetCurrentResult, SessionHistoryMessage, TaskContext } from 'shepaw-acp-sdk';

import type { AcpEngineSpec } from './engines.js';
import { resolveCodexCliBinary, resolveZcodeCliBinary, spawnCommand } from './engines.js';
import { loadUpstreamSessionTranscript } from './session-history.js';
import {
  buildSetModelResult,
  configOptionsToModelsList,
  findModelConfigOption,
  mergeConfigOptions,
} from './config-options.js';
import {
  advertisedModesList,
  describeSessionModePlan,
  displayNameForMode,
  planRequestedMode,
  requestedSessionMode,
  resolveRequestedModeId,
} from './session-mode.js';
import { log } from './debug.js';
import { flushAgentMessage, mapSessionUpdate } from './session-mapper.js';
import {
  attachActiveSession,
  canRestorePersistedSession,
  discardLoadReplayUpdates,
  supportsSessionDelete,
  supportsSessionList,
  supportsSessionLoad,
  supportsSessionResume,
} from './session-lifecycle.js';
import { filterListedSessions } from './sessions-filter.js';
import { resolveNexuspouchMcpServers } from './nexuspouch-mcp.js';
import { resolvePeerStoreMcpServers } from './peer-store-mcp-resolve.js';
import { ensureShepawShim } from './shepaw-cli-shim.js';
import { defaultStoreContextPath } from './store-write-context.js';
import {
  promptToPlainText,
  SessionTranscriptSink,
} from './session-transcript-sink.js';
import { prependHistoryToPrompt, type PriorHistoryTurn } from './session-rehydrate.js';
import {
  CURSOR_STALE_AUTH_MESSAGE,
  CURSOR_STALE_AUTH_RETRIES,
  isPossibleStaleAuthPrefix,
  isStaleAuthMessage,
} from './stale-auth.js';
import { TerminalHost } from './terminal-host.js';
import {
  buildActions,
  formatPermissionPrompt,
  pickOption,
  resolveSelectedOption,
} from './permission/format.js';
import { PermissionPolicy } from './permission/policy.js';

type DrainTurnResult =
  | { readonly kind: 'ok' }
  | { readonly kind: 'stale_auth'; readonly text: string };

/**
 * Outcome of one restore attempt against the upstream agent. `timed_out`
 * means the agent was killed + restarted mid-attempt, so a retry on the fresh
 * connection is worthwhile; `failed` means resume/load answered with an error
 * (session gone or rejected) so retrying immediately is futile.
 */
type RestoreAttempt =
  | { readonly kind: 'restored'; readonly session: acp.ActiveSession }
  | { readonly kind: 'failed' }
  | { readonly kind: 'timed_out' };

/**
 * Upstream ACP CLIs (esp. Cursor) sometimes die idle or get SIGTERM'd by the
 * OS / parent. Exit 143 = 128+SIGTERM. Detect so we can respawn + retry instead
 * of surfacing a one-shot failure that a manual resend would "fix".
 */
export function isAcpAgentExitedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /ACP agent exited\b/i.test(msg);
}

/** How many times to respawn after an unexpected upstream exit within one turn. */
const ACP_EXIT_RETRIES = 2;

/**
 * ACP SDK `RequestError` often uses the opaque message "Internal error" while
 * putting the real cause in `.data` / nested `.cause`. Expand that for logs + UI.
 */
export function formatAcpError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts: string[] = [err.message];
  const data = (err as { data?: unknown }).data;
  if (data !== undefined && data !== null) {
    try {
      const s = typeof data === 'string' ? data : JSON.stringify(data);
      if (s.length > 0 && s !== '{}' && !parts[0]?.includes(s)) {
        parts.push(s.length > 500 ? `${s.slice(0, 500)}…` : s);
      }
    } catch {
      /* ignore */
    }
  }
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message.length > 0 && !parts[0]?.includes(cause.message)) {
    parts.push(cause.message);
  } else if (typeof cause === 'string' && cause.length > 0) {
    parts.push(cause);
  }
  return parts.join(' — ');
}

function isSignalTermination(code: number | null, signal: NodeJS.Signals | null): boolean {
  return (
    signal === 'SIGTERM' ||
    signal === 'SIGKILL' ||
    // Node reports signal deaths as 128+N on some paths
    code === 143 ||
    code === 137
  );
}

export interface TurnContext {
  readonly taskCtx: TaskContext;
  readonly signal: AbortSignal;
}

export type SessionOrigin = 'live' | 'restored' | 'created';

export type { PriorHistoryTurn } from './session-rehydrate.js';

export interface RunPromptTurnOptions {
  readonly getStoredAcpSessionId?: (shepawSessionId: string) => string | undefined;
  readonly onAcpSessionId?: (shepawSessionId: string, acpSessionId: string) => void;
  /** Called when a persisted upstream mapping cannot be restored (stale / hung). */
  readonly onRestoreFailed?: (shepawSessionId: string) => void;
  /**
   * Called with the upstream session id that a conversation is abandoning
   * (restore failed → fork, stale-auth retry, etc.). The id still exists
   * agent-side; callers persist it so session/list sync never surfaces the
   * orphaned half as a new app session.
   */
  readonly onAbandonedAcpSessionId?: (acpSessionId: string) => void;
  /**
   * App-side transcript for this Shepaw conversation. Injected only when
   * `session/new` opens a fresh upstream session (restore failed / first
   * bind), so a process death cannot silently wipe context.
   */
  readonly priorHistory?: ReadonlyArray<PriorHistoryTurn>;
}

/** Hooks shared by prompt turns and explicit session cleanup (`agent.sessions.*`). */
export interface ClearShepawSessionHooks {
  readonly getStoredAcpSessionId?: (shepawSessionId: string) => string | undefined;
  readonly onMappingRemoved?: (shepawSessionId: string) => void;
  readonly onAbandonedAcpSessionId?: (acpSessionId: string) => void;
}

export interface AcpSubprocessOptions {
  readonly spec: AcpEngineSpec;
  readonly cwd: string;
  /** Extra env vars forwarded to the ACP agent subprocess. */
  readonly env?: Record<string, string | undefined>;
  /** Approval policy consulted before asking the app. Defaults to ask. */
  readonly policy?: PermissionPolicy;
  /** Display name used in permission prompts, e.g. "Claude". */
  readonly agentDisplayName?: string;
}

export class AcpSubprocess {
  private readonly spec: AcpEngineSpec;
  private readonly cwd: string;
  private readonly extraEnv: Record<string, string | undefined>;
  private readonly policy: PermissionPolicy;
  private readonly agentDisplayName: string;
  /** Optional Nexuspouch sessions transcript bypass (P3). */
  private readonly transcriptSink: SessionTranscriptSink | null;

  private child: ChildProcess | undefined;
  private connection: acp.ClientConnection | undefined;
  private initPromise: Promise<void> | undefined;
  private agentCaps: acp.InitializeResponse | undefined;

  private readonly terminals = new TerminalHost();

  /** Active ACP sessions keyed by Shepaw session_id. */
  private readonly sessions = new Map<string, acp.ActiveSession>();

  /** Latest config options per Shepaw session (for model picker). */
  private readonly configByShepawSession = new Map<string, acp.SessionConfigOption[]>();

  /** Preferred model value applied to newly created sessions. */
  private preferredModelValue: string | undefined;

  /** Preferred run / permission mode (Hub `PAW_ACP_SESSION_MODE` or App picker). */
  private preferredModeId: string | undefined;

  /** Latest advertised session modes per Shepaw session. */
  private readonly modesByShepawSession = new Map<string, acp.SessionModeState>();

  /** Current in-flight turn — used by permission/fs handlers. */
  private currentTurn: TurnContext | undefined;

  /** Cached slash commands from the latest available_commands_update. */
  private cachedCommands: acp.AvailableCommand[] = [];
  /** Config options captured by a throwaway warmup session (before any chat). */
  private warmConfigOptions: acp.SessionConfigOption[] | undefined;
  /** Session modes captured by the warmup session. */
  private warmModes: acp.SessionModeState | undefined;

  /**
   * Upstream session ids created only for slash-command / model-config warmup.
   * Cursor persists these even without a prompt; we delete + filter them out of
   * `session/list` so the app doesn't keep prompting to sync empty sessions.
   */
  private readonly disposableUpstreamSessionIds = new Set<string>();

  /** Cursor `session/load` during chat restore can hang; bail out and restart upstream. */
  private static readonly RESTORE_TIMEOUT_MS = 20_000;

  constructor(opts: AcpSubprocessOptions) {
    this.spec = opts.spec;
    this.cwd = opts.cwd;
    this.extraEnv = opts.env ?? {};
    this.policy = opts.policy ?? new PermissionPolicy();
    this.agentDisplayName = opts.agentDisplayName ?? opts.spec.defaultAgentName ?? 'The agent';
    this.preferredModeId = requestedSessionMode({ ...process.env, ...this.extraEnv });
    const agentKey = opts.spec.id || this.agentDisplayName;
    this.transcriptSink = SessionTranscriptSink.fromEnv(process.env, agentKey);
    if (this.transcriptSink) {
      log('nexuspouch transcript sink enabled for agent=%s', agentKey);
    }
  }

  get capabilities(): acp.InitializeResponse | undefined {
    return this.agentCaps;
  }

  get availableCommands(): ReadonlyArray<acp.AvailableCommand> {
    return this.cachedCommands;
  }

  /**
   * Warm `cachedCommands` even before any chat turn has happened.
   *
   * Normally `cachedCommands` is only populated by the `available_commands_update`
   * notification observed while draining a live prompt turn — so right after a
   * (re)start, `agent.commands.list` returns `[]` until the user sends a first
   * message (this is what made the peer slash-command palette disappear right
   * after restarting an agent-bridge instance). Claude Code proactively emits
   * `available_commands_update` a moment after `session/new`, with no prompt
   * required, so we create a disposable session on the live connection just to
   * capture it. Claude Code does not persist such sessions; Cursor does — we
   * delete them when supported and always exclude them from session/list.
   */
  async ensureCommandsWarm(): Promise<void> {
    if (this.cachedCommands.length > 0) return;
    await this.start();
    if (this.connection === undefined) return;

    let session: acp.ActiveSession | undefined;
    let disposableId: string | undefined;
    try {
      session = await this.connection.agent.buildSession(this.cwd).start();
      disposableId = session.sessionId;
      this.disposableUpstreamSessionIds.add(disposableId);
      this.warmConfigOptions = mergeConfigOptions(
        this.warmConfigOptions,
        session.newSessionResponse.configOptions,
      );
      this.warmModes = session.modes ?? session.newSessionResponse.modes ?? this.warmModes;
      const idleMs = 400;
      const maxMs = 4_000;
      const startedAt = Date.now();
      let lastAt = startedAt;
      while (Date.now() - startedAt < maxMs) {
        const pending = await Promise.race([
          session.nextUpdate(),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 100)),
        ]);
        if (pending === undefined) {
          if (Date.now() - lastAt >= idleMs) break;
          continue;
        }
        lastAt = Date.now();
        if (pending.kind === 'stop') break;
        if (pending.update.sessionUpdate === 'available_commands_update') {
          this.cachedCommands = pending.update.availableCommands ?? [];
        } else if (pending.update.sessionUpdate === 'config_option_update') {
          this.warmConfigOptions = mergeConfigOptions(
            this.warmConfigOptions,
            pending.update.configOptions,
          );
        }
        if (this.cachedCommands.length > 0 && findModelConfigOption(this.warmConfigOptions) !== undefined) {
          break;
        }
      }
    } catch (err) {
      log('ensureCommandsWarm failed: %s', err instanceof Error ? err.message : String(err));
    } finally {
      if (disposableId !== undefined) {
        await this.tryDeleteUpstreamSession(disposableId);
      }
      session?.dispose();
    }
  }

  /** Upstream ACP session ids currently held by this subprocess (real chat turns). */
  getActiveUpstreamSessionIds(): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const session of this.sessions.values()) {
      ids.add(session.sessionId);
    }
    return ids;
  }

  private async tryDeleteUpstreamSession(sessionId: string): Promise<void> {
    if (this.connection === undefined) return;
    if (!supportsSessionDelete(this.agentCaps)) return;
    try {
      await this.connection.agent.request(acp.methods.agent.session.delete, { sessionId });
      log('deleted disposable upstream session %s', sessionId);
    } catch (err) {
      log(
        'session/delete failed for %s: %s',
        sessionId,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /** Whether the upstream agent can enumerate sessions (`session/list`). */
  get supportsList(): boolean {
    return supportsSessionList(this.agentCaps);
  }

  /** Whether the upstream agent can `session/load`-replay a transcript. */
  get supportsLoad(): boolean {
    return supportsSessionLoad(this.agentCaps);
  }

  /**
   * Replay a session's transcript via an ephemeral `session/load` connection
   * (keeps the live serving subprocess untouched). Returns `[]` if the agent
   * can't load sessions. `upstreamSessionId` must be the agent-side id.
   */
  async loadSessionTranscript(
    upstreamSessionId: string,
    opts?: { sessionUpdatedAt?: string },
  ): Promise<SessionHistoryMessage[]> {
    // Avoid spawning a second cursor-agent while a chat turn is using the cwd.
    const deadline = Date.now() + 120_000;
    while (this.currentTurn !== undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await this.start();
    if (!supportsSessionLoad(this.agentCaps)) return [];
    return loadUpstreamSessionTranscript(this.spec, this.cwd, upstreamSessionId, this.extraEnv, {
      idleMs: 400,
      sessionUpdatedAt: opts?.sessionUpdatedAt,
    });
  }

  /**
   * List the upstream agent's sessions via `session/list` on the persistent
   * connection. Returns `[]` if the agent doesn't advertise the capability
   * (e.g. codebuddy) so callers degrade gracefully.
   */
  async listSessions(
    cwd?: string,
    opts?: { preserveUpstreamIds?: Iterable<string>; orphanedUpstreamIds?: Iterable<string> },
  ): Promise<acp.SessionInfo[]> {
    await this.start();
    if (this.connection === undefined) return [];
    if (!supportsSessionList(this.agentCaps)) return [];
    try {
      const response = (await this.connection.agent.request(acp.methods.agent.session.list, {
        cwd: cwd ?? this.cwd,
      })) as acp.ListSessionsResponse;
      const raw = response.sessions ?? [];
      const preserveUpstreamIds = opts?.preserveUpstreamIds === undefined
        ? new Set<string>()
        : new Set(opts.preserveUpstreamIds);
      const orphanedUpstreamIds = opts?.orphanedUpstreamIds === undefined
        ? new Set<string>()
        : new Set(opts.orphanedUpstreamIds);
      return filterListedSessions(raw, {
        disposableUpstreamIds: this.disposableUpstreamSessionIds,
        orphanedUpstreamIds,
        preserveUpstreamIds,
        activeUpstreamIds: this.getActiveUpstreamSessionIds(),
      });
    } catch (err) {
      log('session/list failed: %s', err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  /** Start the subprocess and initialize the ACP connection. */
  async start(): Promise<void> {
    if (this.initPromise !== undefined) {
      // Exit handler normally clears initPromise; if we observe a dead child
      // first (race), drop the stale promise and respawn.
      if (this.isUpstreamDead()) {
        this.initPromise = undefined;
        this.connection = undefined;
        this.child = undefined;
        this.disposeSessions();
      } else {
        return this.initPromise;
      }
    }
    this.initPromise = this.doStart();
    return this.initPromise;
  }

  /** True when we still hold a child handle that has already exited/been killed. */
  private isUpstreamDead(): boolean {
    if (this.child === undefined) return false;
    return this.child.killed || this.child.exitCode !== null || this.child.signalCode !== null;
  }

  private async doStart(): Promise<void> {
    const mergedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.extraEnv,
    };
    // Official codex-acp prefers CODEX_PATH over its bundled @openai/codex.
    // npx installs often omit the optional platform package; point at a real CLI.
    if (
      this.spec.id === 'codex' &&
      (mergedEnv.CODEX_PATH === undefined || mergedEnv.CODEX_PATH.length === 0)
    ) {
      const codexBin = resolveCodexCliBinary();
      if (codexBin !== null) {
        mergedEnv.CODEX_PATH = codexBin;
        log('CODEX_PATH unset; using local Codex CLI: %s', codexBin);
      }
    }
    if (
      this.spec.id === 'zcode' &&
      (mergedEnv.ZCODE_BIN === undefined || mergedEnv.ZCODE_BIN.length === 0)
    ) {
      const zcodeBin = resolveZcodeCliBinary();
      if (zcodeBin !== null) {
        mergedEnv.ZCODE_BIN = zcodeBin;
        log('ZCODE_BIN unset; using local ZCode runtime: %s', zcodeBin);
      }
    }
    if (this.spec.id === 'deepseek-harness') {
      const mode = requestedSessionMode(mergedEnv);
      if (
        mode !== undefined &&
        (mergedEnv.DSH_PERMISSION_MODE === undefined || mergedEnv.DSH_PERMISSION_MODE.length === 0)
      ) {
        mergedEnv.DSH_PERMISSION_MODE = mode;
        log('DSH_PERMISSION_MODE unset; using Hub session mode: %s', mode);
      }
    }
    if (this.spec.spawnEnv !== undefined) {
      for (const [key, value] of Object.entries(this.spec.spawnEnv)) {
        if (mergedEnv[key] === undefined || mergedEnv[key] === '') {
          mergedEnv[key] = value;
        }
      }
    }

    const { command, args } = spawnCommand(this.spec, mergedEnv);
    log('spawning ACP agent: %s %s (cwd=%s)', command, args.join(' '), this.cwd);

    let stderrTail = '';

    const child = spawn(command, args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: augmentAgentEnv(mergedEnv),
    });

    child.on('error', (err) => {
      log('ACP agent spawn failed: %s', err.message);
      this.connection?.close(err);
      this.connection = undefined;
      this.child = undefined;
      this.initPromise = undefined;
      this.disposeSessions();
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      stderrTail = (stderrTail + text).slice(-2048);
      const line = text.trim();
      if (line.length > 0 && line.length <= 500) {
        log('agent stderr: %s', line);
      } else if (line.length > 500) {
        log('agent stderr: %s…', line.slice(0, 500));
      }
    });

    const exitError = (code: number | null, signal: NodeJS.Signals | null): Error => {
      // 143/SIGTERM is process death, not auth — don't blame CURSOR_API_KEY.
      let hint = '';
      if (isSignalTermination(code, signal)) {
        hint = ' — upstream agent process was terminated';
      } else if (this.spec.id === 'cursor') {
        hint = ' — check CURSOR_API_KEY or run cursor-agent login';
      } else if (this.spec.id === 'codex') {
        hint =
          ' — install Codex CLI (`npm i -g @openai/codex`) or set CODEX_PATH; run `codex login` if needed';
      } else if (this.spec.id === 'zcode') {
        hint =
          ' — install ZCode (https://zcode.z.ai) or set ZCODE_BIN; sign in so ~/.zcode/v2/config.json exists';
      } else if (this.spec.id === 'deepseek-harness') {
        hint =
          ' — set DEEPSEEK_API_KEY; put cordis.yml in the instance cwd (see Hub engine setup)';
      }
      const detail = stderrTail.trim().length > 0 ? ` stderr: ${summarizeStderr(stderrTail)}` : '';
      return new Error(`ACP agent exited (${code ?? signal})${hint}${detail}`);
    };

    child.on('exit', (code, signal) => {
      log('ACP agent exited code=%s signal=%s', code, signal);
      const err = exitError(code, signal);
      this.connection?.close(err);
      this.connection = undefined;
      this.child = undefined;
      this.initPromise = undefined;
      this.disposeSessions();
    });

    if (child.stdin === null || child.stdout === null) {
      throw new Error('ACP agent subprocess missing stdin/stdout pipes');
    }

    this.child = child;

    const input = Writable.toWeb(child.stdin);
    const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);

    const clientApp = acp
      .client({ name: 'shepaw-acp-proxy' })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        this.handleRequestPermission(ctx.params, ctx.signal),
      )
      .onRequest(acp.methods.client.fs.readTextFile, (ctx) =>
        this.handleReadTextFile(ctx.params),
      )
      .onRequest(acp.methods.client.fs.writeTextFile, (ctx) =>
        this.handleWriteTextFile(ctx.params),
      )
      .onRequest(acp.methods.client.terminal.create, (ctx) =>
        Promise.resolve(this.terminals.create(ctx.params)),
      )
      .onRequest(acp.methods.client.terminal.output, (ctx) =>
        Promise.resolve(this.terminals.output(ctx.params)),
      )
      .onRequest(acp.methods.client.terminal.waitForExit, (ctx) =>
        this.terminals.waitForExit(ctx.params),
      )
      .onRequest(acp.methods.client.terminal.kill, (ctx) =>
        Promise.resolve(this.terminals.kill(ctx.params)),
      )
      .onRequest(acp.methods.client.terminal.release, (ctx) =>
        Promise.resolve(this.terminals.release(ctx.params)),
      );

    this.connection = clientApp.connect(stream);

    try {
      const initResult = await this.connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
          terminal: true,
          session: {
            configOptions: { boolean: {} },
          },
        },
        clientInfo: {
          name: 'shepaw-acp-proxy',
          title: 'Shepaw ACP Proxy',
          version: '0.2.0',
        },
      });

      this.agentCaps = initResult;
      log(
        'ACP initialized: protocol v%s agent=%s resume=%s load=%s',
        initResult.protocolVersion,
        initResult.agentInfo?.title ?? initResult.agentInfo?.name ?? 'unknown',
        supportsSessionResume(initResult),
        supportsSessionLoad(initResult),
      );
    } catch (err) {
      const base = err instanceof Error ? err : new Error(String(err));
      // Don't re-tag signal deaths / already-hinted exits as auth failures.
      if (
        this.spec.id === 'cursor' &&
        !base.message.includes('cursor-agent login') &&
        !isAcpAgentExitedError(base)
      ) {
        throw new Error(`${base.message} (Cursor: invalid API key or run cursor-agent login)`);
      }
      throw base;
    }
  }

  async stop(): Promise<void> {
    this.disposeSessions();
    this.terminals.disposeAll();
    this.connection?.close();
    this.connection = undefined;
    if (this.child !== undefined && !this.child.killed) {
      this.child.kill('SIGTERM');
    }
    this.child = undefined;
    this.initPromise = undefined;
  }

  /** Upstream ACP subprocess metrics for Hub /status. */
  getRuntimeSnapshot(): {
    acpConnected: boolean;
    acpSessionCount: number;
    hasActiveTurn: boolean;
  } {
    return {
      acpConnected: this.connection !== undefined && this.child !== undefined && !this.child.killed,
      acpSessionCount: this.sessions.size,
      hasActiveTurn: this.currentTurn !== undefined,
    };
  }

  modelsList(shepawSessionId?: string): ModelsListResult {
    if (shepawSessionId !== undefined && shepawSessionId.length > 0) {
      const scoped = configOptionsToModelsList(this.configByShepawSession.get(shepawSessionId));
      if (scoped.models.length > 0) return scoped;
    }
    for (const opts of this.configByShepawSession.values()) {
      const list = configOptionsToModelsList(opts);
      if (list.models.length > 0) return list;
    }
    if (this.warmConfigOptions !== undefined) {
      const warm = configOptionsToModelsList(this.warmConfigOptions);
      if (warm.models.length > 0) return warm;
    }
    return { models: [], current: undefined };
  }

  async setModel(modelValue: string, shepawSessionId?: string): Promise<ModelsSetCurrentResult> {
    this.preferredModelValue = modelValue;

    if (shepawSessionId !== undefined) {
      const session = this.sessions.get(shepawSessionId);
      if (session !== undefined) {
        await this.applyModelToSession(session, shepawSessionId, modelValue);
        const opts = this.configByShepawSession.get(shepawSessionId);
        return buildSetModelResult(opts, modelValue);
      }
    }

    for (const [sid, session] of this.sessions) {
      await this.applyModelToSession(session, sid, modelValue);
      const opts = this.configByShepawSession.get(sid);
      return buildSetModelResult(opts, modelValue);
    }

    return { model: modelValue };
  }

  modesList(shepawSessionId?: string): ModesListResult {
    const fromSession = (sid: string): ModesListResult => {
      const session = this.sessions.get(sid);
      return advertisedModesList({
        configOptions: this.configByShepawSession.get(sid),
        modes: this.modesByShepawSession.get(sid)
          ?? session?.modes
          ?? session?.newSessionResponse.modes,
        currentOverride: this.preferredModeId,
      });
    };

    if (shepawSessionId !== undefined && shepawSessionId.length > 0) {
      const scoped = fromSession(shepawSessionId);
      if (scoped.modes.length > 0) return scoped;
    }
    for (const sid of this.sessions.keys()) {
      const list = fromSession(sid);
      if (list.modes.length > 0) return list;
    }
    return advertisedModesList({
      configOptions: this.warmConfigOptions,
      modes: this.warmModes,
      currentOverride: this.preferredModeId,
    });
  }

  async setMode(modeValue: string, shepawSessionId?: string): Promise<ModesSetCurrentResult> {
    const listed = this.modesList(shepawSessionId);
    let resolved = modeValue;
    if (listed.modes.length > 0) {
      const matched = resolveRequestedModeId(
        listed.modes.map((m) => ({ id: m.value, name: m.display_name })),
        modeValue,
      );
      if (matched === undefined) {
        throw new Error(
          `Unknown session mode "${modeValue}". Available: ${listed.modes.map((m) => m.value).join(', ')}.`,
        );
      }
      resolved = matched;
    }
    this.preferredModeId = resolved;

    if (shepawSessionId !== undefined) {
      const session = this.sessions.get(shepawSessionId);
      if (session !== undefined) {
        await this.applySessionMode(session, shepawSessionId, resolved);
        return {
          mode: resolved,
          display_name: displayNameForMode(this.modesList(shepawSessionId).modes, resolved),
        };
      }
    }

    for (const [sid, session] of this.sessions) {
      await this.applySessionMode(session, sid, resolved);
      return {
        mode: resolved,
        display_name: displayNameForMode(this.modesList(sid).modes, resolved),
      };
    }

    return {
      mode: resolved,
      display_name: displayNameForMode(listed.modes, resolved),
    };
  }

  /** Run one user prompt turn, streaming updates to TaskContext. */
  async runPromptTurn(
    shepawSessionId: string,
    prompt: string | acp.ContentBlock | ReadonlyArray<acp.ContentBlock>,
    turn: TurnContext,
    opts: RunPromptTurnOptions = {},
  ): Promise<void> {
    await this.start();
    if (this.connection === undefined) {
      throw new Error('ACP connection not established');
    }

    // Cursor ACP may emit stale-auth as assistant text; long-lived agents may
    // also die idle (SIGTERM/143). Restart + retry a few times before surfacing.
    let exitRetries = 0;
    for (let retry = 0; ; retry++) {
      this.currentTurn = turn;
      try {
        const result = await this.runPromptTurnOnce(shepawSessionId, prompt, turn, opts);
        if (result.kind === 'ok') return;

        if (retry >= CURSOR_STALE_AUTH_RETRIES) {
          log(
            'cursor stale auth persisted after %d retries; surfacing to user and ending turn',
            CURSOR_STALE_AUTH_RETRIES,
          );
          await this.endShepawSessionAfterStaleAuth(shepawSessionId, opts);
          await flushAgentMessage(turn.taskCtx, result.text);
          // Fresh ACP process so the *next* user message can authenticate again.
          await this.restartUpstreamAgent();
          return;
        }

        log(
          'cursor stale auth detected (retry %d/%d); restarting ACP subprocess',
          retry + 1,
          CURSOR_STALE_AUTH_RETRIES,
        );
        // Fresh upstream session after re-auth — do not resume a stale-auth id.
        this.forgetShepawSession(shepawSessionId, opts);
        await this.restartUpstreamAgent();
      } catch (err) {
        if (isAcpAgentExitedError(err) && exitRetries < ACP_EXIT_RETRIES) {
          exitRetries += 1;
          log(
            'ACP agent exited during turn (retry %d/%d); restarting subprocess',
            exitRetries,
            ACP_EXIT_RETRIES,
          );
          // Keep SessionStore mapping: after respawn, getOrCreateSession should
          // resume/load the same upstream ACP session instead of session/new.
          this.dropLiveShepawSession(shepawSessionId);
          await this.restartUpstreamAgent();
          continue;
        }
        throw err;
      } finally {
        this.currentTurn = undefined;
      }
    }
  }

  private async runPromptTurnOnce(
    shepawSessionId: string,
    prompt: string | acp.ContentBlock | ReadonlyArray<acp.ContentBlock>,
    turn: TurnContext,
    opts: RunPromptTurnOptions,
  ): Promise<DrainTurnResult> {
    if (this.connection === undefined) {
      throw new Error('ACP connection not established');
    }

    let session: acp.ActiveSession;
    let origin: SessionOrigin;
    try {
      ({ session, origin } = await this.getOrCreateSession(shepawSessionId, opts));
    } catch (err) {
      // ACP SDK often wraps upstream failures as RequestError(-32603, "Internal error")
      // with details only in `.data` — surface them so peer/app aren't left guessing.
      const detail = formatAcpError(err);
      log('getOrCreateSession failed for %s: %s', shepawSessionId, detail);
      console.error('[acp-proxy] getOrCreateSession failed:', detail, err);
      throw new Error(detail);
    }

    let promptArg: string | acp.ContentBlock | acp.ContentBlock[] = Array.isArray(prompt)
      ? [...prompt]
      : (prompt as string | acp.ContentBlock);
    if (origin === 'created' && opts.priorHistory !== undefined && opts.priorHistory.length > 0) {
      promptArg = prependHistoryToPrompt(promptArg, opts.priorHistory);
      log(
        'rehydrated %d history turn(s) into new upstream session for shepaw %s',
        opts.priorHistory.length,
        shepawSessionId,
      );
      console.error(
        `[acp-proxy] rehydrated ${opts.priorHistory.length} history turn(s) into new session shepaw=${shepawSessionId}`,
      );
    }
    const userText = promptToPlainText(promptArg as string | acp.ContentBlock | acp.ContentBlock[]);
    if (userText) {
      this.transcriptSink?.append(shepawSessionId, 'user', userText);
    }
    const promptPromise = session.prompt(promptArg).catch((err: unknown) => {
      const detail = formatAcpError(err);
      log('session.prompt failed for %s: %s', shepawSessionId, detail);
      console.error('[acp-proxy] session.prompt failed:', detail, err);
      throw new Error(detail);
    });
    const updatesLoop = this.drainUpdates(session, turn, shepawSessionId);

    const abortPromise = new Promise<never>((_, reject) => {
      if (turn.signal.aborted) {
        reject(new TaskCancelledError());
        return;
      }
      turn.signal.addEventListener(
        'abort',
        () => {
          void this.cancelSession(session.sessionId);
          reject(new TaskCancelledError());
        },
        { once: true },
      );
    });

    const run = Promise.all([promptPromise, updatesLoop]).then(([, drain]) => drain);
    return await Promise.race([run, abortPromise]);
  }

  /**
   * Drop live + persisted mapping for one Shepaw conversation so the next
   * turn opens a fresh upstream session. Optionally deletes the upstream
   * ACP session when the engine supports `session/delete`.
   */
  async clearShepawSession(
    shepawSessionId: string,
    hooks: ClearShepawSessionHooks = {},
  ): Promise<boolean> {
    if (shepawSessionId.length === 0) return false;
    const live = this.sessions.get(shepawSessionId);
    const upstreamId =
      live?.sessionId ?? hooks.getStoredAcpSessionId?.(shepawSessionId);
    if (live !== undefined) {
      hooks.onAbandonedAcpSessionId?.(live.sessionId);
    }
    this.dropLiveShepawSession(shepawSessionId);
    hooks.onMappingRemoved?.(shepawSessionId);
    if (upstreamId !== undefined && upstreamId.length > 0) {
      await this.tryDeleteUpstreamSession(upstreamId);
    }
    return true;
  }

  /** Clear every in-memory Shepaw session handle (mappings cleared via hooks). */
  async clearAllShepawSessions(hooks: ClearShepawSessionHooks = {}): Promise<void> {
    const liveIds = [...this.sessions.keys()];
    for (const id of liveIds) {
      await this.clearShepawSession(id, hooks);
    }
  }

  /** Drop in-memory session state without clearing the persisted Shepaw→ACP map. */
  private dropLiveShepawSession(shepawSessionId: string): void {
    const session = this.sessions.get(shepawSessionId);
    if (session !== undefined) {
      session.dispose();
      this.sessions.delete(shepawSessionId);
    }
    this.configByShepawSession.delete(shepawSessionId);
  }

  /** Drop live + persisted mapping so the next turn opens a fresh ACP session. */
  private forgetShepawSession(shepawSessionId: string, opts: RunPromptTurnOptions): void {
    const session = this.sessions.get(shepawSessionId);
    if (session !== undefined) {
      // The abandoned upstream session stays on the agent; mark it orphaned so
      // session/list sync never adopts it as a duplicate app session.
      opts.onAbandonedAcpSessionId?.(session.sessionId);
    }
    this.dropLiveShepawSession(shepawSessionId);
    opts.onRestoreFailed?.(shepawSessionId);
  }

  /**
   * After exhausting stale-auth retries: clear mapping and drop the upstream
   * session so this Shepaw conversation does not keep reusing a dead ACP id.
   */
  private async endShepawSessionAfterStaleAuth(
    shepawSessionId: string,
    opts: RunPromptTurnOptions,
  ): Promise<void> {
    const session = this.sessions.get(shepawSessionId);
    const upstreamId = session?.sessionId;
    this.forgetShepawSession(shepawSessionId, opts);
    if (upstreamId !== undefined) {
      await this.tryDeleteUpstreamSession(upstreamId);
    }
  }

  private disposeSessions(): void {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    this.configByShepawSession.clear();
    this.modesByShepawSession.clear();
  }

  private rememberConfigOptions(
    shepawSessionId: string,
    configOptions: ReadonlyArray<acp.SessionConfigOption> | undefined | null,
  ): void {
    if (configOptions === undefined || configOptions === null) return;
    const merged = mergeConfigOptions(this.configByShepawSession.get(shepawSessionId), configOptions);
    this.configByShepawSession.set(shepawSessionId, merged);
  }

  private rememberSessionModes(
    shepawSessionId: string,
    modes: acp.SessionModeState | undefined | null,
  ): void {
    if (modes === undefined || modes === null) return;
    this.modesByShepawSession.set(shepawSessionId, modes);
  }

  private rememberCurrentModeId(shepawSessionId: string, modeId: string): void {
    const prev = this.modesByShepawSession.get(shepawSessionId);
    if (prev !== undefined) {
      this.modesByShepawSession.set(shepawSessionId, { ...prev, currentModeId: modeId });
      return;
    }
    this.modesByShepawSession.set(shepawSessionId, { currentModeId: modeId, availableModes: [] });
  }

  private async getOrCreateSession(
    shepawSessionId: string,
    opts: RunPromptTurnOptions,
  ): Promise<{ session: acp.ActiveSession; origin: SessionOrigin }> {
    const existing = this.sessions.get(shepawSessionId);
    if (existing !== undefined) {
      return { session: existing, origin: 'live' };
    }

    const storedId = opts.getStoredAcpSessionId?.(shepawSessionId);

    // Strict binding: when sessions.json already maps this app session to an
    // upstream id, ALWAYS resume/load that id first. Never silently session/new
    // a parallel upstream session after ACP restart — that is exactly how one
    // app conversation drifts onto a second agent session.
    if (storedId !== undefined && storedId.length > 0) {
      if (canRestorePersistedSession(this.agentCaps)) {
        let attempt = await this.tryRestoreSession(this.connection!.agent, shepawSessionId, storedId);
        if (attempt.kind === 'timed_out') {
          // Timeout path already killed + restarted the upstream agent. Retry
          // once on the FRESH connection before giving up.
          log('retrying session restore for %s on restarted upstream', storedId);
          console.error(
            `[acp-proxy] restore timed out for shepaw=${shepawSessionId} upstream=${storedId}; retrying after restart`,
          );
          attempt = await this.tryRestoreSession(this.connection!.agent, shepawSessionId, storedId);
        }
        if (attempt.kind === 'restored') {
          const restored = attempt.session;
          this.sessions.set(shepawSessionId, restored);
          this.rememberSessionModes(shepawSessionId, restored.modes ?? restored.newSessionResponse.modes);
          opts.onAcpSessionId?.(shepawSessionId, restored.sessionId);
          console.error(
            `[acp-proxy] resumed bound session shepaw=${shepawSessionId} → upstream=${restored.sessionId}`,
          );
          await this.applyPreferredSessionMode(restored, shepawSessionId);
          if (this.preferredModelValue !== undefined) {
            await this.applyModelToSession(restored, shepawSessionId, this.preferredModelValue);
          }
          return { session: restored, origin: 'restored' };
        }

        if (attempt.kind === 'timed_out') {
          // Keep the binding. A silent fork here would split history across two
          // upstream sessions the next time the agent comes back healthy.
          const msg =
            `Bound ACP session ${storedId} restore timed out for shepaw ${shepawSessionId}; ` +
            'binding kept — retry the message instead of opening a new upstream session';
          console.error(`[acp-proxy] ${msg}`);
          throw new Error(msg);
        }

        // resume/load rejected. Empty session/list is `unknown` (typical after
        // Cursor idle death) — do not treat it as gone. Fork only when:
        //   - list is non-empty and the id is missing (`no`), or
        //   - we cannot tell (`unknown`) BUT the app sent prior history, so we
        //     can rehydrate instead of opening a blank chat.
        const existence = await this.upstreamSessionExists(storedId);
        const canRehydrate =
          opts.priorHistory !== undefined && opts.priorHistory.length > 0;
        if (existence === 'yes' || (existence === 'unknown' && !canRehydrate)) {
          const msg =
            `Bound ACP session ${storedId} for shepaw ${shepawSessionId} could not be resumed` +
            (existence === 'yes'
              ? ' (still listed upstream)'
              : ' (could not verify via session/list)') +
            '; binding kept — retry instead of forking';
          console.error(`[acp-proxy] ${msg}`);
          throw new Error(msg);
        }

        log(
          'stored ACP session %s %s; creating new session for shepaw %s (rehydrate=%s)',
          storedId,
          existence === 'no' ? 'confirmed gone from session/list' : 'unverified after restore failure',
          shepawSessionId,
          canRehydrate,
        );
        console.error(
          `[acp-proxy] bound upstream ${storedId} ${existence === 'no' ? 'gone' : 'unverified'}; ` +
            `forking new session for shepaw=${shepawSessionId} rehydrate=${canRehydrate}`,
        );
        opts.onAbandonedAcpSessionId?.(storedId);
        opts.onRestoreFailed?.(shepawSessionId);
      } else {
        log(
          'upstream has no session resume/load; cannot restore %s for shepaw %s',
          storedId,
          shepawSessionId,
        );
        console.error(
          `[acp-proxy] upstream cannot resume/load; refusing to replace bound session ${storedId} for shepaw=${shepawSessionId}`,
        );
        throw new Error(
          `Upstream agent cannot resume/load bound session ${storedId}; binding kept`,
        );
      }
    }

    // Use the CURRENT connection — tryRestoreSession may have restarted the
    // upstream agent above, and a stale handle would fail or hang session/new.
    const session = await this.startSessionWithMcp();
    this.sessions.set(shepawSessionId, session);
    opts.onAcpSessionId?.(shepawSessionId, session.sessionId);
    this.rememberConfigOptions(shepawSessionId, session.newSessionResponse.configOptions);
    this.rememberSessionModes(shepawSessionId, session.modes ?? session.newSessionResponse.modes);
    log('created ACP session %s for shepaw session %s', session.sessionId, shepawSessionId);
    console.error(
      `[acp-proxy] created new session shepaw=${shepawSessionId} → upstream=${session.sessionId}`,
    );

    await this.applyPreferredSessionMode(session, shepawSessionId);
    if (this.preferredModelValue !== undefined) {
      await this.applyModelToSession(session, shepawSessionId, this.preferredModelValue);
    }

    return { session, origin: 'created' };
  }

  /**
   * Whether `sessionId` still appears in the upstream agent's raw session/list.
   * Used to decide if a failed restore should fork (gone) or keep the binding
   * (still there / unknown).
   *
   * An empty list is `unknown`, not `no`: after Cursor/Claude idle death the
   * freshly spawned process often lists nothing even though the session still
   * exists on disk. Treating that as "gone" is how one app conversation
   * silently session/new's into amnesia.
   */
  private async upstreamSessionExists(
    sessionId: string,
  ): Promise<'yes' | 'no' | 'unknown'> {
    if (this.connection === undefined) return 'unknown';
    if (!supportsSessionList(this.agentCaps)) return 'unknown';
    try {
      const response = (await this.connection.agent.request(acp.methods.agent.session.list, {
        cwd: this.cwd,
      })) as acp.ListSessionsResponse;
      const raw = response.sessions ?? [];
      if (raw.length === 0) return 'unknown';
      return raw.some((s) => s.sessionId === sessionId) ? 'yes' : 'no';
    } catch (err) {
      log(
        'upstreamSessionExists list failed for %s: %s',
        sessionId,
        err instanceof Error ? err.message : String(err),
      );
      return 'unknown';
    }
  }

  private async tryRestoreSession(
    agent: acp.ClientContext,
    shepawSessionId: string,
    storedId: string,
  ): Promise<RestoreAttempt> {
    if (this.disposableUpstreamSessionIds.has(storedId)) {
      log('skip restore for disposable upstream session %s', storedId);
      return { kind: 'failed' };
    }

    let timedOut = false;
    const restoreWork = this.doTryRestoreSession(agent, shepawSessionId, storedId).then(
      (session): RestoreAttempt =>
        session === undefined ? { kind: 'failed' } : { kind: 'restored', session },
    );
    const timeout = new Promise<RestoreAttempt>((resolve) => {
      setTimeout(() => {
        timedOut = true;
        resolve({ kind: 'timed_out' });
      }, AcpSubprocess.RESTORE_TIMEOUT_MS);
    });

    const result = await Promise.race([restoreWork, timeout]);
    if (timedOut) {
      log(
        'session restore timed out for shepaw=%s upstream=%s; restarting upstream agent',
        shepawSessionId,
        storedId,
      );
      await this.restartUpstreamAgent();
      return { kind: 'timed_out' };
    }
    return result;
  }

  /** Inject Nexuspouch MCP and/or hub peer-store MCP when configured. */
  private mcpServers(): acp.McpServer[] {
    return [
      ...resolveNexuspouchMcpServers(),
      ...resolvePeerStoreMcpServers(),
    ];
  }

  private async startSessionWithMcp(): Promise<acp.ActiveSession> {
    const servers = this.mcpServers();
    let builder = this.connection!.agent.buildSession(this.cwd);
    for (const server of servers) {
      builder = builder.withMcpServer(server);
    }
    if (servers.length > 0) {
      log('injecting %d MCP server(s) into session/new (store)', servers.length);
    }
    return builder.start();
  }

  private async doTryRestoreSession(
    agent: acp.ClientContext,
    shepawSessionId: string,
    storedId: string,
  ): Promise<acp.ActiveSession | undefined> {
    const mcpServers = this.mcpServers();
    // Some engines reject resume/load when MCP servers differ from the original
    // session. Try with the configured MCP set first; if that fails, retry with
    // an empty list before giving up — keeping the app↔upstream binding intact
    // matters more than immediately re-attaching store tools.
    const mcpAttempts: acp.McpServer[][] = mcpServers.length > 0 ? [mcpServers, []] : [[]];

    if (supportsSessionResume(this.agentCaps)) {
      for (const servers of mcpAttempts) {
        try {
          const response = await agent.request(acp.methods.agent.session.resume, {
            sessionId: storedId,
            cwd: this.cwd,
            mcpServers: servers,
          });
          const session = attachActiveSession(agent, storedId, response);
          this.rememberConfigOptions(shepawSessionId, response.configOptions);
          log(
            'resumed ACP session %s (mcp=%d)',
            storedId,
            servers.length,
          );
          return session;
        } catch (err) {
          log(
            'session/resume failed for %s (mcp=%d): %s',
            storedId,
            servers.length,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }

    if (supportsSessionLoad(this.agentCaps)) {
      for (const servers of mcpAttempts) {
        try {
          const response = await agent.request(acp.methods.agent.session.load, {
            sessionId: storedId,
            cwd: this.cwd,
            mcpServers: servers,
          });
          const session = attachActiveSession(agent, storedId, response);
          this.rememberConfigOptions(shepawSessionId, response.configOptions);
          const discarded = await discardLoadReplayUpdates(session);
          log(
            'loaded ACP session %s (discarded %d replay updates, mcp=%d)',
            storedId,
            discarded,
            servers.length,
          );
          return session;
        } catch (err) {
          log(
            'session/load failed for %s (mcp=%d): %s',
            storedId,
            servers.length,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }

    return undefined;
  }

  /** Kill and respawn the upstream agent (hung restore or Cursor stale auth). */
  private async restartUpstreamAgent(): Promise<void> {
    this.disposeSessions();
    try {
      this.connection?.close();
    } catch {
      /* ignore */
    }
    this.connection = undefined;
    if (this.child !== undefined && !this.child.killed) {
      this.child.kill('SIGTERM');
    }
    this.child = undefined;
    this.initPromise = undefined;
    await this.start();
  }

  /**
   * Switch the upstream session into the preferred mode (Hub env or App picker).
   * Unset → leave the agent's default. Remaining `request_permission` calls
   * are forwarded to the App.
   */
  private async applyPreferredSessionMode(
    session: acp.ActiveSession,
    shepawSessionId: string,
  ): Promise<void> {
    if (this.preferredModeId === undefined) return;
    await this.applySessionMode(session, shepawSessionId, this.preferredModeId);
  }

  private async applySessionMode(
    session: acp.ActiveSession,
    shepawSessionId: string,
    requested: string,
  ): Promise<void> {
    if (this.connection === undefined) return;

    const opts =
      this.configByShepawSession.get(shepawSessionId) ??
      session.newSessionResponse.configOptions ??
      [];
    const advertised = this.modesByShepawSession.get(shepawSessionId)
      ?? session.modes
      ?? session.newSessionResponse.modes;
    const plan = planRequestedMode({
      requested,
      configOptions: opts,
      modes: advertised,
    });
    if (plan === undefined) return;

    try {
      if (plan.kind === 'config-select') {
        const response = (await this.connection.agent.request(
          acp.methods.agent.session.setConfigOption,
          {
            sessionId: session.sessionId,
            configId: plan.configId,
            value: plan.value,
            type: 'select' as const,
          },
        )) as acp.SetSessionConfigOptionResponse;
        this.rememberConfigOptions(shepawSessionId, response.configOptions);
      } else {
        await this.connection.agent.request(acp.methods.agent.session.setMode, {
          sessionId: session.sessionId,
          modeId: plan.modeId,
        });
        this.rememberCurrentModeId(shepawSessionId, plan.modeId);
      }
      log('applied session mode %s (%s) for %s', requested, describeSessionModePlan(plan), session.sessionId);
    } catch (err) {
      log(
        'failed to apply session mode %s (%s): %s',
        requested,
        describeSessionModePlan(plan),
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private async applyModelToSession(
    session: acp.ActiveSession,
    shepawSessionId: string,
    modelValue: string,
  ): Promise<void> {
    const opts =
      this.configByShepawSession.get(shepawSessionId) ??
      session.newSessionResponse.configOptions ??
      [];

    const modelOpt = findModelConfigOption(opts);
    if (modelOpt === undefined) return;

    const response = await this.connection!.agent.request(
      acp.methods.agent.session.setConfigOption,
      {
        sessionId: session.sessionId,
        configId: modelOpt.id,
        value: modelValue,
        type: 'select',
      },
    ) as acp.SetSessionConfigOptionResponse;
    this.rememberConfigOptions(shepawSessionId, response.configOptions);
  }

  private async drainUpdates(
    session: acp.ActiveSession,
    turn: TurnContext,
    shepawSessionId: string,
  ): Promise<DrainTurnResult> {
    // Hold agent_message_chunk while it still looks like Cursor's stale-auth
    // reply so we can restart without leaking "Please sign in…" to the UI.
    let agentTextBuffer = '';
    let agentStreaming = false;

    for (;;) {
      if (turn.signal.aborted) {
        throw new TaskCancelledError();
      }

      const msg = await session.nextUpdate();
      if (msg.kind === 'stop') {
        log('prompt stopped: %s', msg.stopReason);
        if (!agentStreaming && isStaleAuthMessage(agentTextBuffer)) {
          return {
            kind: 'stale_auth',
            text: agentTextBuffer.trim().length > 0
              ? agentTextBuffer.trim()
              : CURSOR_STALE_AUTH_MESSAGE,
          };
        }
        if (!agentStreaming && agentTextBuffer.length > 0) {
          await flushAgentMessage(turn.taskCtx, agentTextBuffer);
        }
        // Capture full assistant turn (buffered + already-streamed pieces via buffer).
        if (agentTextBuffer.trim().length > 0 && !isStaleAuthMessage(agentTextBuffer)) {
          this.transcriptSink?.append(shepawSessionId, 'assistant', agentTextBuffer);
        }
        void this.transcriptSink?.flush(shepawSessionId);
        return { kind: 'ok' };
      }

      const update = msg.update;
      if (update.sessionUpdate === 'available_commands_update') {
        this.cachedCommands = update.availableCommands ?? [];
      } else if (update.sessionUpdate === 'config_option_update') {
        this.rememberConfigOptions(shepawSessionId, update.configOptions);
      } else if (update.sessionUpdate === 'current_mode_update') {
        const modeId = (update as { currentModeId?: string }).currentModeId;
        if (typeof modeId === 'string' && modeId.length > 0) {
          this.rememberCurrentModeId(shepawSessionId, modeId);
          this.preferredModeId = modeId;
        }
      }

      if (update.sessionUpdate === 'agent_message_chunk') {
        const content = update.content;
        if (content.type === 'text' && content.text.length > 0) {
          if (agentStreaming) {
            agentTextBuffer += content.text;
            await flushAgentMessage(turn.taskCtx, content.text);
          } else {
            agentTextBuffer += content.text;
            if (!isPossibleStaleAuthPrefix(agentTextBuffer)) {
              await flushAgentMessage(turn.taskCtx, agentTextBuffer);
              agentStreaming = true;
            }
          }
        }
        continue;
      }

      await mapSessionUpdate(update, turn.taskCtx);
    }
  }

  private async cancelSession(sessionId: string): Promise<void> {
    try {
      await this.connection?.agent.notify(acp.methods.agent.session.cancel, { sessionId });
    } catch (err) {
      log('session/cancel failed: %s', err instanceof Error ? err.message : String(err));
    }
  }

  private async handleRequestPermission(
    params: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<acp.RequestPermissionResponse> {
    const turn = this.currentTurn;
    if (turn === undefined) {
      return { outcome: { outcome: 'cancelled' } };
    }

    const toolCall = params.toolCall;

    // 1. Policy pre-check — auto-approve skipped permissions / auto-deny
    //    blocked ones without a remote round trip. `ask` falls through.
    const verdict = this.policy.decide(toolCall);
    if (verdict.decision !== 'ask') {
      const optionId = pickOption(
        params.options,
        verdict.decision,
        verdict.decision === 'allow',
      );
      log(
        'permission %s by policy (%s) for %s [%s]',
        verdict.decision,
        verdict.reason,
        toolCall.title ?? toolCall.toolCallId,
        toolCall.kind ?? 'other',
      );
      if (verdict.decision === 'allow' && optionId !== undefined) {
        return { outcome: { outcome: 'selected', optionId } };
      }
      if (verdict.decision === 'deny' && optionId !== undefined) {
        return { outcome: { outcome: 'selected', optionId } };
      }
      // No matching option to express the decision → cancelled (deny-safe).
      return { outcome: { outcome: 'cancelled' } };
    }

    // 2. Remote review — register the waiter BEFORE emitting the confirmation.
    // On the peer path the phone can relay submitResponse over loopback almost
    // immediately; if we send first and register second, the reply is dropped
    // and Cursor sits on [pending] forever even after "Always allow".
    const prompt = formatPermissionPrompt(this.agentDisplayName, toolCall);
    const confirmationId = `perm_${randomUUID()}`;
    const responsePromise = turn.taskCtx.waitForResponse(confirmationId, {
      timeoutMs: 20 * 60 * 1000,
    });
    await turn.taskCtx.sendActionConfirmation({
      confirmationId,
      prompt,
      actions: buildActions(params.options),
      extra: {
        tool_kind: toolCall.kind ?? 'other',
        tool_call_id: toolCall.toolCallId,
      },
    });
    log(
      'permission request sent (%s) for %s [%s]',
      confirmationId,
      toolCall.title ?? toolCall.toolCallId,
      toolCall.kind ?? 'other',
    );

    try {
      const response = await responsePromise;

      if (signal.aborted || turn.signal.aborted) {
        return { outcome: { outcome: 'cancelled' } };
      }

      const optionId = resolveSelectedOption(params.options, response);
      if (optionId !== undefined) {
        log(
          'permission approved (%s) option=%s for %s',
          confirmationId,
          optionId,
          toolCall.title ?? toolCall.toolCallId,
        );
        return { outcome: { outcome: 'selected', optionId } };
      }
      log(
        'permission reply did not match any option (confirmation=%s raw=%j)',
        confirmationId,
        response,
      );
      return { outcome: { outcome: 'cancelled' } };
    } catch (err) {
      log(
        'permission wait failed (%s): %s',
        confirmationId,
        err instanceof Error ? err.message : String(err),
      );
      return { outcome: { outcome: 'cancelled' } };
    }
  }

  private async handleReadTextFile(
    params: acp.ReadTextFileRequest,
  ): Promise<acp.ReadTextFileResponse> {
    const content = await readFile(params.path, 'utf-8');
    return { content };
  }

  private async handleWriteTextFile(
    params: acp.WriteTextFileRequest,
  ): Promise<acp.WriteTextFileResponse> {
    await mkdir(dirname(params.path), { recursive: true });
    await writeFile(params.path, params.content, 'utf-8');
    return {};
  }
}

function summarizeStderr(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= 240 ? oneLine : `${oneLine.slice(0, 240)}…`;
}

function augmentAgentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
  const current = env[pathKey] ?? env.PATH ?? '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const extras = [
    join(homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ].filter((d) => existsSync(d));
  let next: NodeJS.ProcessEnv =
    extras.length === 0 || current.split(sep).some((p) => extras.includes(p))
      ? { ...env }
      : { ...env, [pathKey]: `${extras.join(sep)}${sep}${current}` };

  // Give upstream agents the `shepaw store …` CLI shim so the app's
  // [implicit] store:// hint works verbatim (see shepaw-cli-shim.ts).
  const shimDir = ensureShepawShim(next);
  if (shimDir !== undefined) {
    const cur = next[pathKey] ?? '';
    if (!cur.split(sep).includes(shimDir)) {
      next = { ...next, [pathKey]: `${shimDir}${sep}${cur}` };
      log('shepaw store CLI shim on PATH: %s', shimDir);
    }
  }

  // Point the CLI at the per-turn store-context file (updated in onChat).
  if (!(next.SHEPAW_STORE_CONTEXT_FILE ?? '').trim()) {
    next = {
      ...next,
      SHEPAW_STORE_CONTEXT_FILE: defaultStoreContextPath(next),
    };
  }

  // Claude Code reads ANTHROPIC_API_KEY. An *empty* API_KEY in the env blocks
  // Claude's normal CLI login (~/.claude) and yields opaque ACP "Internal error".
  // Hub often stores OpenRouter-style keys only under ANTHROPIC_AUTH_TOKEN — copy
  // when present; otherwise drop the empty key so keychain/CLI auth can work.
  const apiKey = next.ANTHROPIC_API_KEY;
  const authToken = next.ANTHROPIC_AUTH_TOKEN;
  if (apiKey === undefined || apiKey.length === 0) {
    if (typeof authToken === 'string' && authToken.length > 0) {
      next = { ...next, ANTHROPIC_API_KEY: authToken };
      log('ANTHROPIC_API_KEY empty; using ANTHROPIC_AUTH_TOKEN for upstream Claude ACP');
    } else if (apiKey !== undefined) {
      const { ANTHROPIC_API_KEY: _drop, ...rest } = next;
      next = rest;
      log('ANTHROPIC_API_KEY was empty string; unset so Claude CLI login can apply');
    }
  }

  // Hub runs headless; avoid cursor-agent trying to open a browser for login.
  if (next.NO_OPEN_BROWSER === undefined) {
    next = { ...next, NO_OPEN_BROWSER: '1' };
  }
  return next;
}
