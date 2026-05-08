/**
 * OpenCode as a Shepaw ACP agent.
 *
 * Architecture overview
 * ─────────────────────
 * OpenCode runs as a separate HTTP server process (`createOpencodeServer`).
 * We start it on a random port at `init()` time and talk to it via
 * `createOpencodeClient()`. The lifecycle is:
 *
 *   1. `init()` → spawn `opend` server, create `OpencodeClient`.
 *   2. `onChat()` → resolve / create an OpenCode session for the Shepaw
 *      session, subscribe to the global SSE event stream
 *      (`client.event.subscribe()`), send the prompt via
 *      `client.session.promptAsync()` (fire-and-forget, 204), then drain
 *      events until `session.idle` fires for our session.
 *   3. SSE event handling:
 *      - `message.part.updated` with `part.type === "text"` → `ctx.sendText`
 *        using the `delta` field for incremental streaming.
 *      - `message.part.updated` with `part.type === "tool"` → collapsible
 *        tool-call block showing tool name + state transitions.
 *      - `message.part.updated` with `part.type === "reasoning"` → italic text
 *        (delta-streamed, same as text).
 *      - `permission.updated` → `ctx.sendConfirmationRequest`, then on reply
 *        call `POST /session/{id}/permissions/{permissionID}`.
 *      - `session.error` → error text.
 *      - `session.idle` for our session → turn complete, return.
 *   4. Session resumption: `SessionStore` maps Shepaw `session_id` →
 *      OpenCode `session.id`. Same OpenCode session is reused for subsequent
 *      messages from the same Shepaw session, giving ChatGPT-style conversation
 *      continuity.
 *
 * Models
 * ──────
 * `GET /provider` returns all providers with their models. We flatten these
 * into `{ value: "providerID/modelID", display_name, description }` entries
 * for the Shepaw model picker. The current model is stored as a
 * `{ providerID, modelID }` pair and injected into every `promptAsync` body.
 *
 * Commands
 * ────────
 * `GET /command` returns OpenCode slash commands.  We merge these with
 * filesystem-scanned markdown commands from `.opencode/commands/` (project)
 * and `~/.opencode/commands/` (user).
 *
 * Tool approval (async_confirmation)
 * ────────────────────────────────────
 * Unlike Codex, OpenCode has a real permission API:
 *   - `permission.updated` SSE event carries the pending permission.
 *   - We forward it via `ctx.sendConfirmationRequest`.
 *   - The user's response ("allow" → `"once"` or "always" → `"always"`,
 *     "deny" → `"reject"`) is POSTed to
 *     `/session/{id}/permissions/{permissionID}`.
 * This means `async_confirmation` is listed in capabilities.
 */

import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import {
  createOpencodeClient,
  createOpencodeServer,
  type Config,
  type Event,
  type EventMessagePartUpdated,
  type EventPermissionUpdated,
  type EventSessionError,
  type EventSessionIdle,
  type EventTodoUpdated,
  type OpencodeClient,
  type ToolPart,
} from '@opencode-ai/sdk';
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
import { OpenCodeModelsProvider } from './commands/models-provider.js';
import { buildRegistry } from './commands/registry.js';

/** Gateway directory name for per-gateway on-disk state (sessions, peers…). */
const GATEWAY_DIR_NAME = 'shepaw-opencode-gateway';

/** Composite model key used as `value` in the model picker. */
function modelKey(providerID: string, modelID: string): string {
  return `${providerID}/${modelID}`;
}

function parseModelKey(key: string): { providerID: string; modelID: string } | undefined {
  const slash = key.indexOf('/');
  if (slash === -1) return undefined;
  return { providerID: key.slice(0, slash), modelID: key.slice(slash + 1) };
}

export interface OpenCodeAgentOptions {
  /** Display name shown in the Shepaw agent card. Default 'OpenCode'. */
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
  /** Working directory for OpenCode sessions. Default `process.cwd()`. */
  cwd?: string;
  /**
   * Initial model in `providerID/modelID` form (e.g. `"anthropic/claude-opus-4-5"`).
   * When not specified, OpenCode's own default model is used.
   */
  model?: string;
  /** Override session-store persistence path. */
  sessionStoreOptions?: SessionStoreOptions;
  /**
   * When set, the gateway opens a reverse tunnel to the Shepaw Channel
   * Service so your phone can reach it from the public internet.
   */
  tunnelConfig?: ChannelTunnelConfig;
  /**
   * Port for the internal OpenCode HTTP server. Default: OS-assigned random.
   * Override only if you need a predictable internal port.
   */
  opencodePort?: number;
  /**
   * Extra system prompt / instructions prepended to each session's first message.
   * Passed as the `system` field in the prompt body.
   */
  systemPrompt?: string;
  /**
   * Per-provider API key overrides, keyed by provider ID (e.g. `"anthropic"`).
   * These are injected into the OpenCode server's `config.provider` block so
   * credentials can be supplied programmatically without relying on environment
   * variables.
   *
   * Example:
   * ```ts
   * providerApiKeys: { anthropic: 'sk-ant-...', openai: 'sk-...' }
   * ```
   */
  providerApiKeys?: Record<string, string>;
  /**
   * Full OpenCode `Config` override. Merged (shallow) into the config passed to
   * `createOpencodeServer`. Useful for fine-grained provider/model settings not
   * covered by the higher-level options above. `providerApiKeys` takes precedence
   * over any `provider[id].options.apiKey` set here.
   */
  opencodeConfig?: Config;
}

interface CommandsDirEntry {
  path: string;
  scope: 'project' | 'user';
}

export class OpenCodeAgent extends ACPAgentServer {
  private readonly cwd: string;
  /** Extra system prompt injected into each OpenCode prompt (separate from base class). */
  private readonly extraSystemPrompt: string | undefined;
  private readonly opencodePort: number | undefined;
  private readonly sessionStore: SessionStore;

  /** Per-provider API keys supplied at construction time (no env-var required). */
  private readonly providerApiKeys: Record<string, string>;

  /** Base OpenCode config merged with providerApiKeys at init time. */
  private readonly opencodeConfig: Config;

  /** Currently-selected model as `{ providerID, modelID }` (may be undefined). */
  private currentModel: { providerID: string; modelID: string } | undefined;

  /** OpenCode HTTP server — started in `init()`. */
  private opencodeServer?: { url: string; close(): void };

  /** OpenCode REST client — created once server is up. */
  private client!: OpencodeClient;

  /** Slash commands directories — `.opencode/commands` + `~/.opencode/commands`. */
  private readonly commandsDirs: CommandsDirEntry[];

  /** Active fs.watch handles — one per existing directory in commandsDirs. */
  private commandsWatchers: FSWatcher[] = [];

  /** Debounce timer (200ms) coalescing bursts of fs events. */
  private commandsRebuildTimer: NodeJS.Timeout | undefined;

  /** sha1 of the last broadcast snapshot; broadcasts suppressed when unchanged. */
  private lastCommandsSnapshot = '';

  constructor(opts: OpenCodeAgentOptions = {}) {
    super({
      name: opts.name ?? 'OpenCode',
      peersPath: opts.peersPath,
      enrollmentsPath: opts.enrollmentsPath,
      description: 'Bridge OpenCode to Shepaw — control OpenCode from your phone',
      systemPrompt: '',
      tunnelConfig: opts.tunnelConfig,
    });

    this.cwd = opts.cwd ?? process.cwd();
    this.extraSystemPrompt = opts.systemPrompt;
    this.opencodePort = opts.opencodePort;

    this.providerApiKeys = opts.providerApiKeys ?? {};
    this.opencodeConfig = opts.opencodeConfig ?? {};

    this.sessionStore = new SessionStore(
      opts.sessionStoreOptions ?? { gatewayDirName: GATEWAY_DIR_NAME },
    );

    if (opts.model) {
      this.currentModel = parseModelKey(opts.model);
    }

    this.commandsDirs = [
      { path: join(this.cwd, '.opencode', 'commands'), scope: 'project' },
      { path: join(homedir(), '.opencode', 'commands'), scope: 'user' },
    ];

    // Slash command registry — /model, /status, /mcp.
    const modelsProvider = new OpenCodeModelsProvider({
      getClient: () => this.client,
      getCurrentModelKey: () =>
        this.currentModel
          ? modelKey(this.currentModel.providerID, this.currentModel.modelID)
          : undefined,
    });

    this.slashRegistry = buildRegistry({
      onModelApplied: (key: string) => {
        const parsed = parseModelKey(key);
        if (parsed) this.currentModel = parsed;
      },
    }) as unknown as SlashCommandRegistry<unknown>;

    this.slashProviders = {
      models: modelsProvider,
    } satisfies SlashProviders;
  }

  async init(): Promise<void> {
    await this.sessionStore.load();

    // Start the OpenCode server process.
    log.gateway('starting opencode server (cwd=%s)', this.cwd);

    // Build the provider config block from providerApiKeys, merged over any
    // base opencodeConfig the caller provided.
    const providerOverrides: Config['provider'] = {};
    for (const [providerId, apiKey] of Object.entries(this.providerApiKeys)) {
      providerOverrides[providerId] = {
        ...(this.opencodeConfig.provider?.[providerId] ?? {}),
        options: {
          ...(this.opencodeConfig.provider?.[providerId]?.options ?? {}),
          apiKey,
        },
      };
    }
    const resolvedConfig: Config = {
      ...this.opencodeConfig,
      provider: {
        ...this.opencodeConfig.provider,
        ...providerOverrides,
      },
    };

    this.opencodeServer = await createOpencodeServer({
      port: this.opencodePort,
      config: resolvedConfig,
    });
    log.gateway('opencode server listening at %s', this.opencodeServer.url);

    // Build a client pointing at our local server.
    this.client = createOpencodeClient({ baseUrl: this.opencodeServer.url });

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
        'async_confirmation',
      ],
      supported_protocols: ['acp'],
    };
  }

  // ── Slash commands ────────────────────────────────────────────────────────

  override async onCommandsList(params: CommandsListParams): Promise<CommandsListResult> {
    // 1. SDK registry built-ins (/model, /status, /mcp).
    const registryResult = await super.onCommandsList(params);
    const registryCmds = registryResult.commands;

    // 2. OpenCode native commands from GET /command.
    const ocCmds: SlashCommandInfo[] = [];
    try {
      const res = await this.client.command.list();
      if (res.data) {
        for (const cmd of res.data) {
          ocCmds.push({
            name: cmd.name,
            description: cmd.description,
            scope: 'builtin',
            source: 'sdk',
          });
        }
      }
    } catch (err) {
      log.gateway('commands list: opencode GET /command failed: %s', (err as Error).message);
    }

    // 3. Filesystem-scanned markdown commands.
    const scannedGroups = await Promise.all(
      this.commandsDirs.map((d) => scanCommandsDir(d.path, d.scope)),
    );
    const scanned = scannedGroups.flat();

    // Merge: filesystem wins over agent wins over registry for same name.
    const byName = new Map<string, SlashCommandInfo>();
    for (const c of registryCmds) byName.set(c.name, c);
    for (const c of ocCmds) byName.set(c.name, c);
    for (const c of scanned) byName.set(c.name, c);

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
    const current = this.currentModel
      ? modelKey(this.currentModel.providerID, this.currentModel.modelID)
      : undefined;
    return { models, current };
  }

  override async onModelsSetCurrent(
    p: ModelsSetCurrentParams,
  ): Promise<ModelsSetCurrentResult> {
    const provider = (this.slashProviders as SlashProviders).models;
    const entries = provider ? await provider.list() : [];
    const found = entries.find((m) => m.id === p.model);
    if (!found) throw new Error(`Unknown model: ${p.model}`);
    const parsed = parseModelKey(p.model);
    if (!parsed) throw new Error(`Invalid model key format: ${p.model}`);
    this.currentModel = parsed;
    return { model: p.model, display_name: found.name };
  }

  // ── Chat ──────────────────────────────────────────────────────────────────

  override async onChat(
    ctx: TaskContext,
    message: string,
    _kwargs: ChatKwargs,
  ): Promise<void> {
    // Resolve or create an OpenCode session for this Shepaw session.
    let ocSessionId = this.sessionStore.get(ctx.sessionId);
    if (!ocSessionId) {
      const createRes = await this.client.session.create({
        body: { title: `Shepaw session ${ctx.sessionId.slice(0, 8)}` },
        query: { directory: this.cwd },
      });
      if (!createRes.data) {
        throw new Error('Failed to create OpenCode session');
      }
      ocSessionId = createRes.data.id;
      this.sessionStore.set(ctx.sessionId, ocSessionId);
      log.gateway('created opencode session %s for shepaw session %s', ocSessionId, ctx.sessionId);
    } else {
      log.gateway('resuming opencode session %s for shepaw session %s', ocSessionId, ctx.sessionId);
    }

    // Subscribe to the global SSE event stream BEFORE sending the prompt
    // so we don't miss early events.
    const sseResult = await this.client.event.subscribe();
    const sseStream = sseResult.stream;

    // Send the prompt asynchronously (fire-and-forget, returns 204).
    const promptBody: {
      parts: Array<{ type: 'text'; text: string }>;
      model?: { providerID: string; modelID: string };
      system?: string;
    } = {
      parts: [{ type: 'text', text: message }],
    };
    if (this.currentModel) {
      promptBody.model = this.currentModel;
    }
    if (this.extraSystemPrompt) {
      promptBody.system = this.extraSystemPrompt;
    }

    await this.client.session.promptAsync({
      path: { id: ocSessionId },
      body: promptBody,
      query: { directory: this.cwd },
    });

    // Drain SSE events until session.idle fires for our session, or abort.
    const abortController = this.activeTasks.get(ctx.taskId) ?? new AbortController();

    // Per-part tracking for incremental delta streaming.
    const partText = new Map<string, string>();
    const partRendered = new Map<string, string>();

    try {
      for await (const event of sseStream) {
        if (abortController.signal.aborted) break;

        if (!event) continue;

        const done = await this.handleOpenCodeEvent(
          ctx,
          event,
          ocSessionId,
          partText,
          partRendered,
        );
        if (done) break;
      }
    } finally {
      // Close the SSE connection regardless of how we exit.
      try {
        await sseStream.return(undefined);
      } catch {
        // ignore
      }
    }
  }

  /** Returns `true` when the turn is complete (session.idle for our session). */
  private async handleOpenCodeEvent(
    ctx: TaskContext,
    event: Event,
    ocSessionId: string,
    partText: Map<string, string>,
    partRendered: Map<string, string>,
  ): Promise<boolean> {
    switch (event.type) {
      case 'message.part.updated': {
        const e = event as EventMessagePartUpdated;
        const part = e.properties.part;
        const delta = e.properties.delta;

        // Only handle parts that belong to our session.
        if (part.sessionID !== ocSessionId) break;

        if (part.type === 'text') {
          // Stream text incrementally using delta when available; fall back
          // to computing the delta from the accumulated full text.
          if (delta && delta.length > 0) {
            await ctx.sendText(delta);
            partText.set(part.id, (partText.get(part.id) ?? '') + delta);
          } else {
            const prev = partText.get(part.id) ?? '';
            const newDelta = part.text.slice(prev.length);
            if (newDelta.length > 0) {
              await ctx.sendText(newDelta);
              partText.set(part.id, part.text);
            }
          }
        } else if (part.type === 'reasoning') {
          // Reasoning text, displayed as italic.
          if (delta && delta.length > 0) {
            await ctx.sendText(`*${delta}*`);
            partText.set(part.id, (partText.get(part.id) ?? '') + delta);
          } else {
            const prev = partText.get(part.id) ?? '';
            const newDelta = part.text.slice(prev.length);
            if (newDelta.length > 0) {
              await ctx.sendText(`*${newDelta}*`);
              partText.set(part.id, part.text);
            }
          }
        } else if (part.type === 'tool') {
          const toolPart = part as ToolPart;
          // Emit a collapsible block on the first update for this tool call,
          // then update status as it progresses.
          const prevRendered = partRendered.get(part.id);
          const state = toolPart.state;

          if (!prevRendered) {
            // First time we see this tool — open a collapsible block.
            await ctx.sendMessageMetadata({
              collapsible: true,
              collapsibleTitle: `🔧 ${toolPart.tool}`,
              autoCollapse: true,
            });
            partRendered.set(part.id, state.status);
          } else if (prevRendered !== state.status) {
            // Status changed — emit a status line.
            const statusEmoji =
              state.status === 'completed'
                ? '✅'
                : state.status === 'error'
                  ? '❌'
                  : state.status === 'running'
                    ? '⏳'
                    : '⏸';
            const titleStr =
              state.status === 'completed' || state.status === 'running'
                ? (state as { title?: string }).title ?? toolPart.tool
                : toolPart.tool;
            await ctx.sendText(`\n${statusEmoji} ${titleStr}\n`);
            partRendered.set(part.id, state.status);
          }
        }
        break;
      }

      case 'permission.updated': {
        const e = event as EventPermissionUpdated;
        const perm = e.properties;
        if (perm.sessionID !== ocSessionId) break;

        log.gateway('permission request: %s (id=%s)', perm.title, perm.id);

        // Forward to the Shepaw app as an async confirmation request and
        // wait for the user's response within this turn.
        const cid = await ctx.sendActionConfirmation({
          prompt: perm.title,
          actions: [
            { label: 'Allow once', value: 'allow' },
            { label: 'Always allow', value: 'always' },
            { label: 'Deny', value: 'deny' },
          ],
          extra: {
            permission_id: perm.id,
            permission_type: perm.type,
          },
        });
        const reply = await ctx.waitForResponse(cid);
        const chosen = typeof reply.value === 'string' ? reply.value : 'allow';

        // Map the user's choice to OpenCode's permission response.
        let ocResponse: 'once' | 'always' | 'reject';
        switch (chosen) {
          case 'always':
            ocResponse = 'always';
            break;
          case 'deny':
            ocResponse = 'reject';
            break;
          default:
            // 'allow' or anything else → allow once
            ocResponse = 'once';
        }

        try {
          await this.client.postSessionIdPermissionsPermissionId({
            path: { id: ocSessionId, permissionID: perm.id },
            body: { response: ocResponse },
            query: { directory: this.cwd },
          });
          log.gateway('permission %s responded: %s', perm.id, ocResponse);
        } catch (err) {
          log.gateway('permission response failed: %s', (err as Error).message);
        }
        break;
      }

      case 'todo.updated': {
        const e = event as EventTodoUpdated;
        if (e.properties.sessionID !== ocSessionId) break;
        // Render the todo list.
        const lines = e.properties.todos.map((t) => {
          const icon =
            t.status === 'completed'
              ? '✅'
              : t.status === 'in_progress'
                ? '⏳'
                : t.status === 'cancelled'
                  ? '❌'
                  : '⬜';
          return `${icon} ${t.content}`;
        });
        if (lines.length > 0) {
          await ctx.sendText(`\n${lines.join('\n')}\n`);
        }
        break;
      }

      case 'session.error': {
        const e = event as EventSessionError;
        if (e.properties.sessionID && e.properties.sessionID !== ocSessionId) break;
        const err = e.properties.error;
        if (err) {
          const msg =
            'data' in err && typeof err.data === 'object' && err.data !== null
              ? (err.data as { message?: string }).message ?? JSON.stringify(err)
              : JSON.stringify(err);
          await ctx.sendText(`\n❌ Error: ${msg}\n`);
        }
        // Session error means the turn is over (failed).
        return true;
      }

      case 'session.idle': {
        const e = event as EventSessionIdle;
        if (e.properties.sessionID === ocSessionId) {
          log.gateway('session %s idle — turn complete', ocSessionId);
          return true;
        }
        break;
      }

      default:
        break;
    }

    return false;
  }

  // ── Commands file watchers ────────────────────────────────────────────────

  private startCommandsWatchers(): void {
    for (const d of this.commandsDirs) {
      try {
        const watcher = watch(d.path, { recursive: true }, () => {
          this.scheduleCommandsRebuild();
        });
        watcher.unref?.();
        this.commandsWatchers.push(watcher);
      } catch {
        // Directory doesn't exist yet — fine.
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

  /** Clean up: close watchers and shut down the OpenCode server. */
  async shutdown(): Promise<void> {
    this.stopCommandsWatchers();
    try {
      this.opencodeServer?.close();
      log.gateway('opencode server closed');
    } catch {
      /* ignore */
    }
  }
}
