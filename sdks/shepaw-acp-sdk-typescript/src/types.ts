/**
 * Data types for the Shepaw ACP protocol.
 *
 * Wire-compatible with the Python `shepaw_acp_sdk.types` module.
 * All JSON field names stay snake_case on the wire.
 */

// ── Parser output types ────────────────────────────────────────────

/** A plain text fragment emitted by the directive stream parser. */
export interface ACPTextChunk {
  readonly kind: 'text';
  readonly content: string;
}

/** A parsed `<<<directive ... >>>` block. */
export interface ACPDirective {
  readonly kind: 'directive';
  readonly directiveType: string;
  readonly payload: Record<string, unknown>;
}

/** Union produced by `ACPDirectiveStreamParser`. */
export type ACPParsedEvent = ACPTextChunk | ACPDirective;

export function isTextChunk(event: ACPParsedEvent): event is ACPTextChunk {
  return event.kind === 'text';
}

export function isDirective(event: ACPParsedEvent): event is ACPDirective {
  return event.kind === 'directive';
}

// ── Agent metadata ─────────────────────────────────────────────────

/** Metadata describing an ACP agent's capabilities (returned by `agent.getCard`). */
export interface AgentCard {
  agent_id: string;
  name: string;
  description: string;
  version: string;
  capabilities: string[];
  supported_protocols: string[];
}

export const DEFAULT_CAPABILITIES: readonly string[] = ['chat', 'streaming'];
export const DEFAULT_PROTOCOLS: readonly string[] = ['acp'];

// ── LLM helpers (kept for parity with the Python SDK) ──────────────

/** A tool call returned by an LLM. */
export interface LLMToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Result of a streaming chat with tools. */
export interface LLMStreamResult {
  text_content: string;
  tool_calls: LLMToolCall[];
}

// ── Conversation history ───────────────────────────────────────────

export type ConversationRole = 'user' | 'assistant' | 'system';

export interface ConversationMessage {
  role: ConversationRole;
  content: string;
}

// ── UI component options (sent via notifications) ──────────────────

export interface UIActionOption {
  label: string;
  value: string;
}

export interface UIChoiceOption {
  label: string;
  value: string;
  description?: string;
}

export type UIFormFieldType =
  | 'text'
  | 'password'
  | 'email'
  | 'number'
  | 'checkbox'
  | 'select'
  | 'textarea'
  | 'radio_group'
  | 'checkbox_group';

export interface UIFormField {
  name: string;
  label: string;
  type: UIFormFieldType;
  placeholder?: string;
  required?: boolean;
  default?: unknown;
  /**
   * For `select` / `radio_group` (pick one) and `checkbox_group` (pick many).
   * Each option is a `{ label, value }` pair; an optional `description`
   * can be shown beneath the label in the Shepaw app.
   */
  options?: UIChoiceOption[];
}

// ── Typed chat kwargs passed to `onChat` ───────────────────────────

/**
 * Per-chat kwargs forwarded to `ACPAgentServer.onChat`.
 *
 * Mirrors the `**kwargs` bundle that the Python server passes to its
 * `on_chat` override (see `shepaw_acp_sdk/server.py:_run_chat_task`).
 */
export interface ChatKwargs {
  session_id: string;
  /** The raw history (if any) supplied by the app on this chat call. */
  history: ConversationMessage[] | undefined;
  /** Current conversation messages (app history + new user message). */
  messages: ConversationMessage[];
  attachments: unknown;
  system_prompt: string;
  group_context: unknown;
  ui_component_version: string | undefined;
  user_id: string;
  message_id: string;
  is_history_supplement: boolean;
  /** The raw `agent.chat` params (for anything not surfaced above). */
  params: Record<string, unknown>;
}

// ── Slash command discovery (agent.commands.list) ──────────────────

/** Origin of a command entry. */
export type CommandScope = 'project' | 'user' | 'builtin';

/** How a command entry was discovered. */
export type CommandSource = 'sdk' | 'filesystem';

/**
 * Metadata for a single slash command surfaced by the agent.
 *
 * `name` is the bare command name without a leading slash ("plan" not "/plan").
 * The shepaw client prepends "/" when inserting into chat input.
 *
 * All field names stay snake_case on the wire to match the rest of the
 * protocol (e.g., `argument_hint`, not `argumentHint`).
 */
export interface SlashCommandInfo {
  name: string;
  description?: string;
  argument_hint?: string;
  scope?: CommandScope;
  source?: CommandSource;
}

/** `agent.commands.list` request params (reserved for future filters). */
export interface CommandsListParams {
  // Reserved: scope, include_hidden, query.
}

/** `agent.commands.list` response. */
export interface CommandsListResult {
  commands: SlashCommandInfo[];
}

/** `agent.commands.changed` notification params. */
export interface CommandsChangedParams {
  commands: SlashCommandInfo[];
}

// ── Model selection (agent.models.list / agent.models.setCurrent) ──

/**
 * Metadata for a model offered by the underlying agent SDK.
 *
 * Mirrors `ModelInfo` from the Claude/CodeBuddy Agent SDKs:
 *   - `value` is the id you pass to `query.setModel(value)` (and also back
 *     through `agent.models.setCurrent`).
 *   - `display_name` is human-readable (wire stays snake_case).
 */
export interface ModelInfo {
  value: string;
  display_name: string;
  description: string;
}

/** `agent.models.list` request params (reserved). */
export interface ModelsListParams {}

/** `agent.models.list` response. */
export interface ModelsListResult {
  models: ModelInfo[];
  /** The currently-selected model value, if any. */
  current?: string;
}

/** `agent.models.setCurrent` request params. */
export interface ModelsSetCurrentParams {
  model: string;
}

/** `agent.models.setCurrent` response. */
export interface ModelsSetCurrentResult {
  model: string;
  display_name?: string;
}

// ── JSON-RPC envelopes (generic shapes) ────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponseSuccess {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponseError {
  jsonrpc: '2.0';
  id: string | number | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcResponseSuccess | JsonRpcResponseError;

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;
