/**
 * OpenAI Codex as a Shepaw ACP agent.
 *
 * Wraps `@openai/codex-sdk`'s `Codex` + `Thread` and routes:
 *   - `agent_message` items → `ctx.sendText` (streaming via ItemUpdatedEvent)
 *   - `command_execution` items → collapsible metadata block + summary text
 *   - `file_change` items → collapsible metadata block + file list
 *   - `reasoning` items → forwarded as italic text
 *   - `todo_list` items → formatted task list
 *   - `error` items → forwarded as error text
 *
 * Session resumption: Codex threads are persisted in `~/.codex/sessions`.
 * We keep a per-Shepaw-session mapping (session_id → thread_id) in a
 * `SessionStore` so that subsequent `agent.chat` messages are sent on the
 * same thread rather than starting a fresh one. This mirrors the
 * ClaudeCodeAgent's `--resume` approach at the SDK level.
 *
 * Tool-approval: Codex's `approvalPolicy` is exposed as a CLI flag. Unlike
 * Claude Code's agent-side `canUseTool` callback, Codex handles approvals
 * internally (`on-request` = ask, `on-failure` = retry on sandbox failure,
 * `never` = never ask, `untrusted` = always ask). We default to `on-request`
 * which mirrors Claude Code's `default` permission mode.
 *
 * Slash commands: `/model`, `/status`, `/mcp` are handled via the SDK's
 * `SlashCommandRegistry`. Custom commands can be placed in `.codex/commands/`
 * (project scope) or `~/.codex/commands/` (user scope) as markdown files.
 */

import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import {
  Codex,
  type ApprovalMode,
  type CodexOptions,
  type ItemCompletedEvent,
  type ItemStartedEvent,
  type ItemUpdatedEvent,
  type ModelReasoningEffort,
  type SandboxMode,
  type ThreadEvent,
  type ThreadOptions,
  type WebSearchMode,
} from '@openai/codex-sdk';
import {
  ACPAgentServer,
  SessionStore,
  SlashCommandRegistry,
  type SessionStoreOptions,
  type ChannelTunnelConfig,
  type ChatKwargs,
  type CommandsListParams,
  type CommandsListResult,
  type ModelInfo,
  type ModelsListParams,
  type ModelsListResult,
  type ModelsSetCurrentParams,
  type ModelsSetCurrentResult,
  type SlashCommandInfo,
  type SlashProviders,
  type TaskContext,
} from 'shepaw-acp-sdk';

import { log } from './debug.js';
import { scanCommandsDir } from './commands-scanner.js';
import { CodexModelsProvider } from './commands/models-provider.js';
import { buildRegistry, type CodexCfg } from './commands/registry.js';

/** Gateway directory name — keeps our on-disk state isolated from other bridges. */
const GATEWAY_DIR_NAME = 'shepaw-codex-gateway';

export interface CodexAgentOptions {
  /** Display name shown in the Shepaw agent card. Default 'Codex'. */
  name?: string;
  /**
   * Override the authorized-peers allowlist path. Defaults to the SDK
   * resolution order (`SHEPAW_PEERS_PATH` env var, XDG, or `~/.config/`).
   */
  peersPath?: string;
  /**
   * Override the enrollments (pairing-code) store path. Defaults to the SDK
   * resolution order (`SHEPAW_ENROLLMENTS_PATH` env var, XDG, or `~/.config/`).
   */
  enrollmentsPath?: string;
  /** Working directory for Codex. Default `process.cwd()`. */
  cwd?: string;
  /** OpenAI model id (e.g. 'o4-mini', 'o3'). Defaults to Codex CLI default. */
  model?: string;
  /** OpenAI API key. Passed as `OPENAI_API_KEY` env var to the Codex CLI process. */
  apiKey?: string;
  /** Base URL override for the OpenAI-compatible API endpoint. */
  apiBaseUrl?: string;
  /**
   * How the agent handles tool-call approvals.
   *   - `never`      — run all tools without asking (full autonomy)
   *   - `on-request` — ask for approval on every tool call (default, mirrors Claude Code's 'default' mode)
   *   - `on-failure` — run tools, retry and ask only on sandbox failures
   *   - `untrusted`  — always ask (same as `on-request` but semantically for untrusted environments)
   */
  approvalPolicy?: ApprovalMode;
  /** Sandbox security level. Default `workspace-write` (can write within the cwd). */
  sandboxMode?: SandboxMode;
  /** Model reasoning effort. Default determined by the Codex CLI. */
  reasoningEffort?: ModelReasoningEffort;
  /** Web search mode. Default `disabled`. */
  webSearchMode?: WebSearchMode;
  /** Whether to skip the git repository check. Default false. */
  skipGitRepoCheck?: boolean;
  /** Additional directories the agent may access outside the cwd. */
  additionalDirectories?: string[];
  /** Extra system prompt / instructions prepended to the Codex session. */
  systemPrompt?: string;
  /** Override session-store persistence path. */
  sessionStoreOptions?: SessionStoreOptions;
  /**
   * When set, the gateway opens a reverse tunnel to the Shepaw Channel
   * Service so your phone can reach it from the public internet.
   */
  tunnelConfig?: ChannelTunnelConfig;
  /**
   * Override the path to the Codex CLI binary. Default: resolved from PATH.
   * Useful when Codex is installed at a non-standard location.
   */
  codexPathOverride?: string;
}

interface CommandsDirEntry {
  path: string;
  scope: 'project' | 'user';
}

export class CodexAgent extends ACPAgentServer {
  private readonly cfg: Required<
    Pick<CodexAgentOptions, 'cwd' | 'approvalPolicy' | 'sandboxMode'>
  > &
    Pick<
      CodexAgentOptions,
      | 'model'
      | 'apiKey'
      | 'apiBaseUrl'
      | 'reasoningEffort'
      | 'webSearchMode'
      | 'skipGitRepoCheck'
      | 'additionalDirectories'
      | 'systemPrompt'
      | 'codexPathOverride'
    >;

  private readonly sessionStore: SessionStore;
  private readonly codex: Codex;

  /** Currently-active model id (may be changed at runtime via /model). */
  private currentModel: string | undefined;

  /** Slash commands read from `.codex/commands/` and `~/.codex/commands/`. */
  private readonly commandsDirs: CommandsDirEntry[];

  /** Active fs.watch handles — one per existing directory in commandsDirs. */
  private commandsWatchers: FSWatcher[] = [];

  /** Debounce timer (200ms) coalescing bursts of fs events. */
  private commandsRebuildTimer: NodeJS.Timeout | undefined;

  /** sha1 of the last broadcast snapshot; broadcasts suppressed when unchanged. */
  private lastCommandsSnapshot = '';

  constructor(opts: CodexAgentOptions = {}) {
    super({
      name: opts.name ?? 'Codex',
      peersPath: opts.peersPath,
      enrollmentsPath: opts.enrollmentsPath,
      description: 'Bridge OpenAI Codex to Shepaw — control Codex from your phone',
      systemPrompt: opts.systemPrompt ?? '',
      tunnelConfig: opts.tunnelConfig,
    });

    this.cfg = {
      cwd: opts.cwd ?? process.cwd(),
      approvalPolicy: opts.approvalPolicy ?? 'on-request',
      sandboxMode: opts.sandboxMode ?? 'workspace-write',
      model: opts.model,
      apiKey: opts.apiKey,
      apiBaseUrl: opts.apiBaseUrl,
      reasoningEffort: opts.reasoningEffort,
      webSearchMode: opts.webSearchMode,
      skipGitRepoCheck: opts.skipGitRepoCheck,
      additionalDirectories: opts.additionalDirectories,
      systemPrompt: opts.systemPrompt,
      codexPathOverride: opts.codexPathOverride,
    };

    this.currentModel = opts.model;

    this.sessionStore = new SessionStore(
      opts.sessionStoreOptions ?? { gatewayDirName: GATEWAY_DIR_NAME },
    );

    // Commands directories — `.codex/commands` in cwd (project) and
    // `~/.codex/commands` (user). Mirrors Claude Code's `.claude/commands`.
    this.commandsDirs = [
      { path: join(this.cfg.cwd, '.codex', 'commands'), scope: 'project' },
      { path: join(homedir(), '.codex', 'commands'), scope: 'user' },
    ];

    // Build Codex SDK options.
    const codexOptions: CodexOptions = {};
    if (opts.codexPathOverride) codexOptions.codexPathOverride = opts.codexPathOverride;
    if (opts.apiBaseUrl) codexOptions.baseUrl = opts.apiBaseUrl;
    if (opts.apiKey) codexOptions.apiKey = opts.apiKey;

    const envOverrides: Record<string, string> = {};
    if (opts.apiKey) envOverrides['OPENAI_API_KEY'] = opts.apiKey;
    if (opts.apiBaseUrl) envOverrides['OPENAI_BASE_URL'] = opts.apiBaseUrl;
    if (Object.keys(envOverrides).length > 0) {
      codexOptions.env = { ...(process.env as Record<string, string>), ...envOverrides };
    }

    this.codex = new Codex(codexOptions);

    // Set up slash command registry.
    const modelsProvider = new CodexModelsProvider({
      getCurrentModel: () => this.currentModel,
    });

    this.slashRegistry = buildRegistry({
      onModelApplied: (id) => {
        this.currentModel = id;
        this.cfg.model = id;
      },
    }) as unknown as SlashCommandRegistry<unknown>;

    this.slashProviders = {
      models: modelsProvider,
    } satisfies SlashProviders;
  }

  async init(): Promise<void> {
    await this.sessionStore.load();
    this.startCommandsWatchers();
  }

  override getAgentCard() {
    return {
      agent_id: this.agentId,
      name: this.name,
      description: this.description,
      version: '0.1.0',
      capabilities: [
        'chat',
        'streaming',
        'code_editing',
        'file_operations',
        'bash_execution',
      ],
      supported_protocols: ['acp'],
    };
  }

  // ── Slash commands ────────────────────────────────────────────────────────

  override async onCommandsList(params: CommandsListParams): Promise<CommandsListResult> {
    // Merge: SDK registry built-ins + filesystem-scanned markdown commands.
    const registryResult = await super.onCommandsList(params);
    const registryCmds = registryResult.commands;

    const scannedGroups = await Promise.all(
      this.commandsDirs.map((d) => scanCommandsDir(d.path, d.scope)),
    );
    const scanned = scannedGroups.flat();

    // Dedup: filesystem entries win over SDK entries of the same name.
    const byName = new Map<string, SlashCommandInfo>();
    for (const c of registryCmds) byName.set(c.name, c);
    for (const c of scanned) {
      if (!byName.has(c.name) || byName.get(c.name)?.source !== 'filesystem') {
        byName.set(c.name, c);
      }
    }
    return { commands: [...byName.values()] };
  }

  // ── Models ────────────────────────────────────────────────────────────────

  override async onModelsList(_p: ModelsListParams): Promise<ModelsListResult> {
    const provider = (this.slashProviders as SlashProviders).models;
    const entries = provider ? await provider.list() : [];
    const models: ModelInfo[] = entries.map((e) => ({
      value: e.id,
      display_name: e.name,
      description: e.description ?? '',
    }));
    return { models, current: this.currentModel };
  }

  override async onModelsSetCurrent(
    p: ModelsSetCurrentParams,
  ): Promise<ModelsSetCurrentResult> {
    const provider = (this.slashProviders as SlashProviders).models;
    const entries = provider ? await provider.list() : [];
    const found = entries.find((m) => m.id === p.model);
    if (!found) throw new Error(`Unknown model: ${p.model}`);
    this.currentModel = p.model;
    this.cfg.model = p.model;
    return { model: p.model, display_name: found.name };
  }

  // ── Chat ──────────────────────────────────────────────────────────────────

  override async onChat(
    ctx: TaskContext,
    message: string,
    _kwargs: ChatKwargs,
  ): Promise<void> {
    const abortController =
      this.activeTasks.get(ctx.taskId) ?? new AbortController();

    // Build ThreadOptions shared for both new and resumed threads.
    const threadOptions: ThreadOptions = {
      workingDirectory: this.cfg.cwd,
      approvalPolicy: this.cfg.approvalPolicy,
      sandboxMode: this.cfg.sandboxMode,
    };
    if (this.cfg.model !== undefined) threadOptions.model = this.cfg.model;
    if (this.cfg.reasoningEffort !== undefined)
      threadOptions.modelReasoningEffort = this.cfg.reasoningEffort;
    if (this.cfg.webSearchMode !== undefined)
      threadOptions.webSearchMode = this.cfg.webSearchMode;
    if (this.cfg.skipGitRepoCheck !== undefined)
      threadOptions.skipGitRepoCheck = this.cfg.skipGitRepoCheck;
    if (this.cfg.additionalDirectories !== undefined)
      threadOptions.additionalDirectories = this.cfg.additionalDirectories;

    // Resume an existing Codex thread if we've seen this Shepaw session before.
    const existingThreadId = this.sessionStore.get(ctx.sessionId);
    const thread = existingThreadId
      ? this.codex.resumeThread(existingThreadId, threadOptions)
      : this.codex.startThread(threadOptions);

    if (existingThreadId) {
      log.gateway('resume codex thread %s for shepaw session %s', existingThreadId, ctx.sessionId);
    }

    // Prepend system prompt to first message when provided and no existing thread.
    const userMessage =
      this.cfg.systemPrompt && !existingThreadId
        ? `${this.cfg.systemPrompt}\n\n${message}`
        : message;

    const { events } = await thread.runStreamed(userMessage, {
      signal: abortController.signal,
    });

    // Track which message items we've already started sending so we can
    // stream incremental updates rather than re-sending the full text each time.
    const seenItemText = new Map<string, string>();

    for await (const event of events) {
      if (abortController.signal.aborted) break;
      await this.handleThreadEvent(ctx, event, seenItemText);
    }

    // Persist the Codex thread ID so the next message resumes the same thread.
    // thread.id is populated after the first event fires (thread.started).
    if (thread.id && !existingThreadId) {
      this.sessionStore.set(ctx.sessionId, thread.id);
      log.gateway('stored codex thread %s for shepaw session %s', thread.id, ctx.sessionId);
    }
  }

  private async handleThreadEvent(
    ctx: TaskContext,
    event: ThreadEvent,
    seenItemText: Map<string, string>,
  ): Promise<void> {
    switch (event.type) {
      case 'thread.started': {
        log.gateway('codex thread started: %s', event.thread_id);
        break;
      }

      case 'turn.started':
      case 'turn.completed': {
        // turn.completed carries usage stats — could be forwarded as metadata in future.
        break;
      }

      case 'turn.failed': {
        await ctx.sendText(`\n❌ Turn failed: ${event.error.message}\n`);
        break;
      }

      case 'error': {
        await ctx.sendText(`\n❌ Error: ${event.message}\n`);
        break;
      }

      case 'item.started': {
        const item = (event as ItemStartedEvent).item;
        if (item.type === 'command_execution') {
          // Emit a collapsible header for the command block.
          await ctx.sendMessageMetadata({
            collapsible: true,
            collapsibleTitle: `$ ${item.command}`,
            autoCollapse: true,
          });
        } else if (item.type === 'file_change') {
          await ctx.sendMessageMetadata({
            collapsible: true,
            collapsibleTitle: 'File changes',
            autoCollapse: true,
          });
        }
        break;
      }

      case 'item.updated': {
        await this.handleItemUpdated(ctx, event as ItemUpdatedEvent, seenItemText);
        break;
      }

      case 'item.completed': {
        await this.handleItemCompleted(ctx, event as ItemCompletedEvent, seenItemText);
        break;
      }
    }
  }

  private async handleItemUpdated(
    ctx: TaskContext,
    event: ItemUpdatedEvent,
    seenItemText: Map<string, string>,
  ): Promise<void> {
    const item = event.item;

    if (item.type === 'agent_message') {
      // Stream incremental text delta to avoid re-sending the full message
      // every event. Codex emits item.updated repeatedly as text accumulates.
      const prev = seenItemText.get(item.id) ?? '';
      const delta = item.text.slice(prev.length);
      if (delta.length > 0) {
        await ctx.sendText(delta);
        seenItemText.set(item.id, item.text);
      }
    } else if (item.type === 'command_execution') {
      // Stream command output incrementally.
      const prev = seenItemText.get(item.id) ?? '';
      const delta = item.aggregated_output.slice(prev.length);
      if (delta.length > 0) {
        await ctx.sendText(delta);
        seenItemText.set(item.id, item.aggregated_output);
      }
    } else if (item.type === 'reasoning') {
      // Stream reasoning text incrementally.
      const prev = seenItemText.get(item.id) ?? '';
      const delta = item.text.slice(prev.length);
      if (delta.length > 0) {
        await ctx.sendText(`*${delta}*`);
        seenItemText.set(item.id, item.text);
      }
    } else if (item.type === 'todo_list') {
      // Re-render the full todo list on each update (it's small).
      const rendered = item.items
        .map((t) => `${t.completed ? '✅' : '⬜'} ${t.text}`)
        .join('\n');
      const prev = seenItemText.get(item.id) ?? '';
      if (rendered !== prev) {
        await ctx.sendText(`\n${rendered}\n`);
        seenItemText.set(item.id, rendered);
      }
    }
  }

  private async handleItemCompleted(
    ctx: TaskContext,
    event: ItemCompletedEvent,
    seenItemText: Map<string, string>,
  ): Promise<void> {
    const item = event.item;

    if (item.type === 'agent_message') {
      // Flush any remaining text that wasn't emitted during item.updated.
      const prev = seenItemText.get(item.id) ?? '';
      const remaining = item.text.slice(prev.length);
      if (remaining.length > 0) {
        await ctx.sendText(remaining);
      }
      seenItemText.delete(item.id);
    } else if (item.type === 'command_execution') {
      // Emit exit code summary after the command finishes.
      const exitCode = item.exit_code ?? '?';
      const status = item.status === 'completed' ? '✅' : '❌';
      const prev = seenItemText.get(item.id) ?? '';
      const remaining = item.aggregated_output.slice(prev.length);
      if (remaining.length > 0) {
        await ctx.sendText(remaining);
      }
      await ctx.sendText(`\n${status} Exit code: ${exitCode}\n`);
      seenItemText.delete(item.id);
    } else if (item.type === 'file_change') {
      // List changed files.
      const lines = item.changes.map((c) => {
        const icon = c.kind === 'add' ? '➕' : c.kind === 'delete' ? '🗑️' : '✏️';
        return `${icon} ${c.path}`;
      });
      const status = item.status === 'completed' ? '' : ' (failed)';
      await ctx.sendText(`${lines.join('\n')}${status}\n`);
    } else if (item.type === 'web_search') {
      await ctx.sendText(`\n🔍 Web search: ${item.query}\n`);
    } else if (item.type === 'error') {
      await ctx.sendText(`\n❌ ${item.message}\n`);
    } else if (item.type === 'reasoning') {
      // Ensure any remaining reasoning text is flushed.
      const prev = seenItemText.get(item.id) ?? '';
      const remaining = item.text.slice(prev.length);
      if (remaining.length > 0) {
        await ctx.sendText(`*${remaining}*`);
      }
      seenItemText.delete(item.id);
    } else if (item.type === 'mcp_tool_call') {
      const status = item.status === 'completed' ? '✅' : '❌';
      const detail = item.error ? `: ${item.error.message}` : '';
      await ctx.sendText(
        `\n${status} MCP tool \`${item.tool}\` on server \`${item.server}\`${detail}\n`,
      );
    }
  }

  // ── Commands file watchers ────────────────────────────────────────────────

  private startCommandsWatchers(): void {
    for (const d of this.commandsDirs) {
      try {
        const watcher = watch(d.path, { recursive: true }, () => {
          this.scheduleCommandsRebuild();
        });
        // Don't let a watcher keep the event loop alive.
        watcher.unref?.();
        this.commandsWatchers.push(watcher);
      } catch {
        // Directory doesn't exist yet — fine. A future `touch` won't trigger
        // a watch, but the next `agent.commands.list` call still scans fresh.
      }
    }
  }

  private stopCommandsWatchers(): void {
    for (const w of this.commandsWatchers) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
    this.commandsWatchers = [];
    if (this.commandsRebuildTimer !== undefined) {
      clearTimeout(this.commandsRebuildTimer);
      this.commandsRebuildTimer = undefined;
    }
  }

  private scheduleCommandsRebuild(): void {
    if (this.commandsRebuildTimer !== undefined) return;
    this.commandsRebuildTimer = setTimeout(() => {
      this.commandsRebuildTimer = undefined;
      void this.rebuildCommandsAndBroadcast();
    }, 200);
  }

  private async rebuildCommandsAndBroadcast(): Promise<void> {
    try {
      const { commands } = await this.onCommandsList({});
      const snapshot = createHash('sha1')
        .update(JSON.stringify(commands))
        .digest('hex');
      if (snapshot === this.lastCommandsSnapshot) return;
      this.lastCommandsSnapshot = snapshot;
      await this.broadcastCommandsChanged(commands);
      log.gateway('commands rebuilt and broadcast (%d entries)', commands.length);
    } catch (err) {
      log.gateway('commands rebuild failed: %s', (err as Error).message);
    }
  }
}
