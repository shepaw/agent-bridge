/** ACP (Agent Communication Protocol) types for Shepaw integration. */

// ─── JSON-RPC 2.0 ─────────────────────────────────────────────────────────

export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
  id: JsonRpcId;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
};

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

export type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// ─── ACP Attachment ────────────────────────────────────────────────────────

export type AcpAttachment = {
  file_name: string;
  mime_type: string;
  size: number;
  data: string; // base64
  type: "image" | "audio" | "video" | "document" | "file";
  extra?: { duration_ms?: number } | null;
};

// ─── ACP History ──────────────────────────────────────────────────────────

export type AcpHistoryEntry = {
  role: "user" | "assistant";
  content: string;
};

// ─── agent.chat params ────────────────────────────────────────────────────

export type AgentChatParams = {
  task_id: string;
  session_id: string;
  message: string;
  user_id: string;
  message_id: string;
  history?: AcpHistoryEntry[];
  total_message_count?: number;
  ui_component_version?: string;
  history_supplement?: boolean;
  additional_history?: AcpHistoryEntry[];
  original_question?: string;
  system_prompt?: string | null;
  group_context?: AcpGroupContext | null;
  attachments?: AcpAttachment[] | null;
};

export type AcpGroupContext = {
  group_id: string;
  group_name: string;
  members: Array<{ id: string; name: string; type: "agent" | "user" }>;
  current_agent_id: string;
};

// ─── Per-connection state ─────────────────────────────────────────────────

export type AcpConnectionState = {
  authenticated: boolean;
  /** Pending hub.* request futures keyed by request id. */
  pending: Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  /** Active task coroutines keyed by task_id. */
  activeTasks: Map<string, AbortController>;
};
