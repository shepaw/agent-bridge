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
import type { ModelsListResult, ModelsSetCurrentResult, SessionHistoryMessage, TaskContext } from 'shepaw-acp-sdk';

import type { AcpEngineSpec } from './engines.js';
import { spawnCommand } from './engines.js';
import { loadUpstreamSessionTranscript } from './session-history.js';
import {
  buildSetModelResult,
  configOptionsToModelsList,
  findModelConfigOption,
  mergeConfigOptions,
} from './config-options.js';
import { log } from './debug.js';
import { mapSessionUpdate } from './session-mapper.js';
import {
  attachActiveSession,
  discardLoadReplayUpdates,
  supportsSessionDelete,
  supportsSessionList,
  supportsSessionLoad,
  supportsSessionResume,
} from './session-lifecycle.js';
import { filterListedSessions } from './sessions-filter.js';
import { TerminalHost } from './terminal-host.js';
import {
  buildActions,
  formatPermissionPrompt,
  pickOption,
  resolveSelectedOption,
} from './permission/format.js';
import { PermissionPolicy } from './permission/policy.js';

export interface TurnContext {
  readonly taskCtx: TaskContext;
  readonly signal: AbortSignal;
}

export interface RunPromptTurnOptions {
  readonly getStoredAcpSessionId?: (shepawSessionId: string) => string | undefined;
  readonly onAcpSessionId?: (shepawSessionId: string, acpSessionId: string) => void;
  /** Called when a persisted upstream mapping cannot be restored (stale / hung). */
  readonly onRestoreFailed?: (shepawSessionId: string) => void;
}

export interface AcpSubprocessOptions {
  readonly spec: AcpEngineSpec;
  readonly cwd: string;
  readonly env?: Record<string, string | undefined>;
  /** Approval policy consulted before asking the app. Defaults to always-ask. */
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

  /** Current in-flight turn — used by permission/fs handlers. */
  private currentTurn: TurnContext | undefined;

  /** Cached slash commands from the latest available_commands_update. */
  private cachedCommands: acp.AvailableCommand[] = [];
  /** Config options captured by a throwaway warmup session (before any chat). */
  private warmConfigOptions: acp.SessionConfigOption[] | undefined;

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
  async loadSessionTranscript(upstreamSessionId: string): Promise<SessionHistoryMessage[]> {
    // Avoid spawning a second cursor-agent while a chat turn is using the cwd.
    const deadline = Date.now() + 120_000;
    while (this.currentTurn !== undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await this.start();
    if (!supportsSessionLoad(this.agentCaps)) return [];
    return loadUpstreamSessionTranscript(this.spec, this.cwd, upstreamSessionId, this.extraEnv, {
      idleMs: 400,
    });
  }

  /**
   * List the upstream agent's sessions via `session/list` on the persistent
   * connection. Returns `[]` if the agent doesn't advertise the capability
   * (e.g. codebuddy) so callers degrade gracefully.
   */
  async listSessions(
    cwd?: string,
    opts?: { preserveUpstreamIds?: Iterable<string> },
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
      return filterListedSessions(raw, {
        disposableUpstreamIds: this.disposableUpstreamSessionIds,
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
      return this.initPromise;
    }
    this.initPromise = this.doStart();
    return this.initPromise;
  }

  private async doStart(): Promise<void> {
    const { command, args } = spawnCommand(this.spec, {
      ...process.env,
      ...this.extraEnv,
    });
    log('spawning ACP agent: %s %s (cwd=%s)', command, args.join(' '), this.cwd);

    let stderrTail = '';

    const child = spawn(command, args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: augmentAgentEnv({
        ...process.env,
        ...this.extraEnv,
      }),
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
      const hint =
        this.spec.id === 'cursor'
          ? ' — check CURSOR_API_KEY or run cursor-agent login'
          : '';
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
      if (this.spec.id === 'cursor' && !base.message.includes('cursor-agent login')) {
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

  /** Run one user prompt turn, streaming updates to TaskContext. */
  async runPromptTurn(
    shepawSessionId: string,
    message: string,
    turn: TurnContext,
    opts: RunPromptTurnOptions = {},
  ): Promise<void> {
    await this.start();
    if (this.connection === undefined) {
      throw new Error('ACP connection not established');
    }

    this.currentTurn = turn;

    try {
      const session = await this.getOrCreateSession(shepawSessionId, opts);

      const promptPromise = session.prompt(message);
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

      await Promise.race([Promise.all([promptPromise, updatesLoop]), abortPromise]);
    } finally {
      this.currentTurn = undefined;
    }
  }

  private disposeSessions(): void {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    this.configByShepawSession.clear();
  }

  private rememberConfigOptions(
    shepawSessionId: string,
    configOptions: ReadonlyArray<acp.SessionConfigOption> | undefined | null,
  ): void {
    if (configOptions === undefined || configOptions === null) return;
    const merged = mergeConfigOptions(this.configByShepawSession.get(shepawSessionId), configOptions);
    this.configByShepawSession.set(shepawSessionId, merged);
  }

  private async getOrCreateSession(
    shepawSessionId: string,
    opts: RunPromptTurnOptions,
  ): Promise<acp.ActiveSession> {
    const existing = this.sessions.get(shepawSessionId);
    if (existing !== undefined) {
      return existing;
    }

    const agent = this.connection!.agent;
    const storedId = opts.getStoredAcpSessionId?.(shepawSessionId);

    if (storedId !== undefined && storedId.length > 0) {
      const skipLoadRestore = this.spec.id === 'cursor' && !supportsSessionResume(this.agentCaps);
      let restored: acp.ActiveSession | undefined;
      if (!skipLoadRestore) {
        restored = await this.tryRestoreSession(agent, shepawSessionId, storedId);
      } else {
        log('skip session/load restore for %s on cursor (use live session/new)', shepawSessionId);
      }
      if (restored !== undefined) {
        this.sessions.set(shepawSessionId, restored);
        opts.onAcpSessionId?.(shepawSessionId, restored.sessionId);
        if (this.preferredModelValue !== undefined) {
          await this.applyModelToSession(restored, shepawSessionId, this.preferredModelValue);
        }
        return restored;
      }
      log('stored ACP session %s unavailable; creating new session', storedId);
      opts.onRestoreFailed?.(shepawSessionId);
    }

    const session = await agent.buildSession(this.cwd).start();
    this.sessions.set(shepawSessionId, session);
    opts.onAcpSessionId?.(shepawSessionId, session.sessionId);
    this.rememberConfigOptions(shepawSessionId, session.newSessionResponse.configOptions);
    log('created ACP session %s for shepaw session %s', session.sessionId, shepawSessionId);

    if (this.preferredModelValue !== undefined) {
      await this.applyModelToSession(session, shepawSessionId, this.preferredModelValue);
    }

    return session;
  }

  private async tryRestoreSession(
    agent: acp.ClientContext,
    shepawSessionId: string,
    storedId: string,
  ): Promise<acp.ActiveSession | undefined> {
    if (this.disposableUpstreamSessionIds.has(storedId)) {
      log('skip restore for disposable upstream session %s', storedId);
      return undefined;
    }

    let timedOut = false;
    const restoreWork = this.doTryRestoreSession(agent, shepawSessionId, storedId);
    const timeout = new Promise<undefined>((resolve) => {
      setTimeout(() => {
        timedOut = true;
        resolve(undefined);
      }, AcpSubprocess.RESTORE_TIMEOUT_MS);
    });

    const result = await Promise.race([restoreWork, timeout]);
    if (timedOut) {
      log(
        'session restore timed out for shepaw=%s upstream=%s; restarting upstream agent',
        shepawSessionId,
        storedId,
      );
      await this.restartUpstreamAfterHungRestore();
      return undefined;
    }
    return result;
  }

  private async doTryRestoreSession(
    agent: acp.ClientContext,
    shepawSessionId: string,
    storedId: string,
  ): Promise<acp.ActiveSession | undefined> {
    const mcpServers: acp.McpServer[] = [];

    if (supportsSessionResume(this.agentCaps)) {
      try {
        const response = await agent.request(acp.methods.agent.session.resume, {
          sessionId: storedId,
          cwd: this.cwd,
          mcpServers,
        });
        const session = attachActiveSession(agent, storedId, response);
        this.rememberConfigOptions(shepawSessionId, response.configOptions);
        log('resumed ACP session %s', storedId);
        return session;
      } catch (err) {
        log(
          'session/resume failed for %s: %s',
          storedId,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    if (supportsSessionLoad(this.agentCaps)) {
      try {
        const response = await agent.request(acp.methods.agent.session.load, {
          sessionId: storedId,
          cwd: this.cwd,
          mcpServers,
        });
        const session = attachActiveSession(agent, storedId, response);
        this.rememberConfigOptions(shepawSessionId, response.configOptions);
        const discarded = await discardLoadReplayUpdates(session);
        log('loaded ACP session %s (discarded %d replay updates)', storedId, discarded);
        return session;
      } catch (err) {
        log(
          'session/load failed for %s: %s',
          storedId,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    return undefined;
  }

  /** Kill and respawn the upstream agent after a hung session/load left the pipe stuck. */
  private async restartUpstreamAfterHungRestore(): Promise<void> {
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
  ): Promise<void> {
    for (;;) {
      if (turn.signal.aborted) {
        throw new TaskCancelledError();
      }

      const msg = await session.nextUpdate();
      if (msg.kind === 'stop') {
        log('prompt stopped: %s', msg.stopReason);
        return;
      }

      const update = msg.update;
      if (update.sessionUpdate === 'available_commands_update') {
        this.cachedCommands = update.availableCommands ?? [];
      } else if (update.sessionUpdate === 'config_option_update') {
        this.rememberConfigOptions(shepawSessionId, update.configOptions);
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
      const optionId = pickOption(params.options, verdict.decision);
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
  const withPath =
    extras.length === 0 || current.split(sep).some((p) => extras.includes(p))
      ? env
      : { ...env, [pathKey]: `${extras.join(sep)}${sep}${current}` };
  // Hub runs headless; avoid cursor-agent trying to open a browser for login.
  if (withPath.NO_OPEN_BROWSER === undefined) {
    return { ...withPath, NO_OPEN_BROWSER: '1' };
  }
  return withPath;
}
