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
  /**
   * Optional explicit action id. The Shepaw app reads `id ?? value ?? label`,
   * so setting this is equivalent to `value` but more explicit; the reply
   * round-trips it back as `selected_action_id`.
   */
  id?: string;
  /**
   * Button styling hint for the app: `primary` (default emphasis), `danger`
   * (destructive / deny), or `secondary`. Unknown/omitted → `secondary`.
   */
  style?: 'primary' | 'secondary' | 'danger';
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
  /** Optional tool defs (e.g. group_dispatch / group_finish) from `agent.chat`. */
  tools: unknown;
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

// ── Session listing (agent.sessions.list) ──────────────────────────

/**
 * A remote conversation session the agent knows about, surfaced to the app so
 * it can mirror the agent's real session list (avoiding "session crossing").
 *
 * Wire names stay snake_case. `session_id` is the id the app must send back as
 * `agent.chat`'s `session_id` to continue THIS exact session — for already
 * app-known sessions this is the app's own session id; for sessions the app has
 * never seen it is the upstream agent session id (which the app then adopts).
 */
export interface SessionInfo {
  session_id: string;
  title?: string;
  /** ISO-8601 last-updated timestamp, if the agent tracks it. */
  updated_at?: string;
  /** Working directory the session is scoped to, if any. */
  cwd?: string;
  /** Extra absolute workspace roots for this session, if any. */
  additional_directories?: string[];
}

/** `agent.sessions.list` request params (reserved for future filters). */
export interface SessionsListParams {
  // Reserved: cwd filter, cursor for pagination.
  cwd?: string;
}

/** `agent.sessions.list` response. */
export interface SessionsListResult {
  sessions: SessionInfo[];
}

/** One replayed conversation turn from a session's transcript. */
export interface SessionHistoryMessage {
  /** `user` or `agent` — matches the app's sender types. */
  role: 'user' | 'agent';
  content: string;
  /** Upstream message id, when available (used for de-dup on the app side). */
  message_id?: string;
  /**
   * ISO-8601 original send time. Always populated by acp-proxy before the
   * history response leaves the bridge (engine adapters fill what they can;
   * remaining gaps are normalized). Clients should treat this as the source of
   * truth for bubble / session-list timestamps.
   */
  created_at?: string;
  /**
   * Pre-split progress section for agent turns (thinking / tool calls / plan),
   * reconstructed from the engine transcript. The app folds it into the same
   * collapsible block it uses for the live stream (`metadata.progress_content`),
   * so a synced bubble looks like the live one instead of dropping progress.
   */
  progress_content?: string;
  /** Collapsible section title — mirrors the live stream's last section title. */
  progress_title?: string;
  /** Whether the progress block starts collapsed (default true). */
  progress_auto_collapse?: boolean;
}

/** `agent.sessions.history` request params. */
export interface SessionHistoryParams {
  session_id: string;
}

/** `agent.sessions.history` response — ordered oldest → newest. */
export interface SessionHistoryResult {
  messages: SessionHistoryMessage[];
}

/** `agent.sessions.delete` request params. */
export interface SessionDeleteParams {
  /** Shepaw-side session id (same value as `agent.chat`'s `session_id`). */
  session_id: string;
}

/** `agent.sessions.delete` response. */
export interface SessionDeleteResult {
  ok: boolean;
}

/** `agent.sessions.clear` request params (reserved). */
export interface SessionsClearParams {
  // Reserved for future filters (cwd, etc.).
}

/** `agent.sessions.clear` response. */
export interface SessionsClearResult {
  ok: boolean;
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

/** `agent.models.list` request params. */
export interface ModelsListParams {
  /** When set, return models/current for this Shepaw session (upstream config). */
  session_id?: string;
}

/** `agent.models.list` response. */
export interface ModelsListResult {
  models: ModelInfo[];
  /** The currently-selected model value, if any. */
  current?: string;
}

/** `agent.models.setCurrent` request params. */
export interface ModelsSetCurrentParams {
  model: string;
  /** When set, apply to this Shepaw session's upstream ACP session. */
  session_id?: string;
}

/** `agent.models.setCurrent` response. */
export interface ModelsSetCurrentResult {
  model: string;
  display_name?: string;
}

// ── Session mode selection (agent.modes.list / agent.modes.setCurrent) ──

/**
 * A native ACP session / permission mode (Cursor Auto/Agent, Claude
 * acceptEdits, Codex on-request, …). Wire stays snake_case like models.
 */
export interface ModeInfo {
  value: string;
  display_name: string;
  description: string;
}

/** `agent.modes.list` request params. */
export interface ModesListParams {
  /** When set, return modes/current for this Shepaw session. */
  session_id?: string;
}

/** `agent.modes.list` response. */
export interface ModesListResult {
  modes: ModeInfo[];
  /** The currently-selected mode value, if any. */
  current?: string;
}

/** `agent.modes.setCurrent` request params. */
export interface ModesSetCurrentParams {
  mode: string;
  /** When set, apply to this Shepaw session's upstream ACP session. */
  session_id?: string;
}

/** `agent.modes.setCurrent` response. */
export interface ModesSetCurrentResult {
  mode: string;
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

// ── Gateway runtime status (Hub supervision) ───────────────────────

/** How busy the gateway is based on in-flight chat tasks. */
export type AgentBusyLevel = 'idle' | 'busy' | 'overloaded';

/** Snapshot returned by GET /status for Hub / supervisor tooling. */
export interface AgentRuntimeStatus {
  /** Milliseconds since the HTTP server started listening. */
  uptimeMs: number;
  /** In-flight agent.chat tasks (one per active turn). */
  activeTasks: number;
  /** Connected, authenticated WebSocket clients. */
  connectedClients: number;
  busyLevel: AgentBusyLevel;
  /** Concurrent chat capacity (`maxConcurrency`); 0 = unlimited. */
  capacity?: number;
  /** Present when the gateway fronts an ACP subprocess (acp-proxy). */
  acpConnected?: boolean;
  acpSessionCount?: number;
  hasActiveTurn?: boolean;
}

/** Derive busy level from the number of active chat tasks. */
export function deriveBusyLevel(activeTasks: number): AgentBusyLevel {
  if (activeTasks <= 0) return 'idle';
  if (activeTasks < 3) return 'busy';
  return 'overloaded';
}
