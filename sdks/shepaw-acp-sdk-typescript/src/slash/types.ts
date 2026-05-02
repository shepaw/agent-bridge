/**
 * Slash-command registry types.
 *
 * Handlers registered into `SlashCommandRegistry` are dispatched by the
 * base `ACPAgentServer.onSlashCommand` whenever the user's message begins
 * with `/`. Each handler declares a `name` (required) and optional
 * `aliases`; lookups are exact-match on the first token after `/`.
 *
 * Handlers receive a minimal `TaskContext` (for text/form output) plus
 * a `SlashCommandDeps` bag:
 *   - `cfg`: the agent's runtime config, mutated in place so the next
 *     `onChat` call picks up the new model / permission mode / etc.
 *   - `providers`: injected capability objects that know how to fetch
 *     SDK-specific data (Tencent vs Claude). Handlers that need a
 *     capability should gracefully fall back when its provider is
 *     absent — rendering a "not supported" text message instead of
 *     throwing, so the task can complete cleanly.
 *   - `registerFormHandler`: fire-and-forget hook for form submissions
 *     — use this instead of the deprecated `ctx.waitForResponse`, which
 *     would pin the task as "still streaming" and break the shepaw form
 *     widget's state.
 */
import type { TaskContext } from '../task-context.js';

// ── Provider interfaces (injected by each concrete agent) ──────────

export interface ModelInfoEntry {
  id: string;
  name: string;
  description?: string;
}

export interface ModelsProvider {
  /** Return the available models. Implementations should cache; list is
   * invoked each time `/model list` or `/status` renders. */
  list(): Promise<ModelInfoEntry[]>;
}

export interface StatusSummary {
  account?: string;
  model?: string;
  permissionMode?: string;
}

export interface StatusProvider {
  summary(): Promise<StatusSummary>;
}

export interface McpServerInfo {
  name: string;
  status: string;
}

export interface McpProvider {
  servers(): Promise<McpServerInfo[]>;
}

export interface PermissionModeInfo {
  id: string;
  name: string;
  description?: string;
}

export interface PermissionsProvider {
  modes(): Promise<PermissionModeInfo[]>;
}

export interface SlashProviders {
  models?: ModelsProvider;
  status?: StatusProvider;
  mcp?: McpProvider;
  permissions?: PermissionsProvider;
}

// ── Handler contract ──────────────────────────────────────────────

export interface SlashCommandDeps<C = unknown> {
  /** The agent's runtime config (mutated in place for state-changing commands). */
  cfg: C;
  providers: SlashProviders;
  /** Register a background handler for a form submit — non-blocking. */
  registerFormHandler(
    id: string,
    fn: (responseData: Record<string, unknown>) => void | Promise<void>,
  ): void;
}

export interface SlashCommandHandler<C = unknown> {
  /** Command name without the leading "/". */
  name: string;
  /** Optional aliases (e.g. "mode" → "permissions"). */
  aliases?: string[];
  /** One-line description shown in the shepaw "/" palette. */
  description: string;
  /** Hint for argument-style completion (e.g. "[model-id|list]"). */
  argumentHint?: string;

  /**
   * Perform the command.
   *
   * @param ctx  Task context — use `sendText` / `sendForm` etc.
   * @param args Tokens after the command, split by whitespace.
   * @param raw  The full trimmed message including the leading "/".
   * @param kwargs Raw chat kwargs (for rare cases handler needs them).
   * @param deps Config + providers + form-handler registration.
   *
   * @returns `true` if handled (server will not invoke `onChat`),
   *          `false` to fall through to the LLM.
   */
  handle(
    ctx: TaskContext,
    args: string[],
    raw: string,
    kwargs: Record<string, unknown>,
    deps: SlashCommandDeps<C>,
  ): Promise<boolean>;
}
