// Shared types mirroring the API responses

export type AgentEngine =
  | 'codebuddy'
  | 'claude-code'
  | 'tclaude'
  | 'codex'
  | 'tcodex'
  | 'opencode'
  | 'openclaw'
  | 'cursor'
  | 'hermes';

export interface TunnelConfig {
  serverUrl: string;
  channelId: string;
  secret: string;
}

/**
 * Hub-level metadata returned by GET /api/instances/meta.
 * credentialHints contains masked (display-only) values for pre-filling forms.
 */
export interface HubMeta {
  lastTunnelServerUrl: string | null;
  /** Masked hint for the last-used tunnel secret (e.g. "hmac***3b2a") */
  lastTunnelSecretHint: string | null;
  /** Per-engine, per-key masked credential hints (e.g. "sk-an***789") */
  credentialHints: Partial<Record<AgentEngine, Record<string, string>>>;
}

export interface InstanceStatus {
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  stoppedAt: string | null;
  lastResult: 'graceful' | 'hard' | 'crashed' | null;
  availability: 'offline' | 'starting' | 'online' | 'degraded';
  busyLevel: 'idle' | 'busy' | 'overloaded' | null;
  activeTasks: number | null;
  connectedClients: number | null;
  acpConnected: boolean | null;
  acpSessionCount: number | null;
  hasActiveTurn: boolean | null;
  uptimeMs: number | null;
  probedAt: string;
  probeError: string | null;
}

export interface Instance {
  id: string;
  label: string;
  engine: string;
  cwd: string;
  port: number;
  host: string;
  baseUrl: string;
  extraArgs: string[];
  createdAt: string;
  /** Tunnel config for Shepaw Channel Service. Secret is present but should be masked in UI. */
  tunnel?: TunnelConfig;
  /** Only key names are exposed — values are never returned by the API. */
  envVarKeys: string[];
  /** Per-instance tool-call approval override; null/undefined = inherit. */
  approval?: ApprovalPolicy | null;
  status: InstanceStatus;
}

export interface Peer {
  fingerprint: string;
  pubkey: string;
  label: string;
  addedAt: string;
}

export interface EnrollToken {
  code: string;
  display: string;
  label: string;
  expiresAt: string;
  pairUrl?: string;
  qrPayload?: string;
  agentId?: string;
  fingerprint?: string;
}

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface EngineInfo {
  id: string;
  displayName: string;
  acpCommand: string;
  builtin: boolean;
  /** True when an operator has disabled this engine. */
  disabled?: boolean;
  /** Per-engine approval override; null = inherit (engine/global). */
  approval?: ApprovalPolicy | null;
  /** Engine-default env var key names (values never exposed). */
  envVarKeys?: string[];
}

export interface CreateCustomEngineInput {
  id: string;
  displayName: string;
  acpCommand: string;
}

export interface UpdateCustomEngineInput {
  displayName?: string;
  acpCommand?: string;
}

/** Patch for PUT /api/engines/:id/override. `null` clears a field. */
export interface EngineOverridePatch {
  disabled?: boolean | null;
  displayName?: string | null;
  approval?: ApprovalPolicy;
  clearApproval?: boolean;
}

export interface MaskedEnvVar {
  key: string;
  value: string;
}

export interface SessionResume {
  sessionId: string;
  message?: string;
  history?: ConversationMessage[];
}

/** Persisted Shepaw → upstream ACP session mapping from sessions.json. */
export interface StoredSession {
  shepawSessionId: string;
  acpSessionId: string;
}

/** Hub-level agent catalog entry (GET /api/pair/agents). */
export interface HubAgentCatalogEntry {
  instanceId: string;
  label: string;
  engine: string;
  agentId: string;
  fingerprint: string;
  publicKey: string;
  wsUrl: string;
  host: string;
  port: number;
  running: boolean;
}

/** Result of POST /api/pair/enroll — one QR for all agents on this host. */
export interface HubPairingResult {
  code: string;
  display: string;
  label: string;
  expiresAt: string;
  createdAt: string;
  bootstrapInstanceId: string;
  pairUrl: string;
  qrPayload: string;
  agents: HubAgentCatalogEntry[];
}

export interface HubPairedDevice {
  fingerprint: string;
  label: string;
  instanceIds: string[];
  addedAt: string | null;
}

/** Runtime status of the device tunnel router. */
export interface GatewayRouterStatus {
  running: boolean;
  pid: number | null;
  routerPort: number;
  startedAt: string | null;
  lastResult: string | null;
}

/** Device-wide tool-call approval policy. */
export type ApprovalMode = 'ask' | 'auto' | 'custom';
export interface ApprovalPolicy {
  mode: ApprovalMode;
  allowKinds: string[];
  askKinds: string[];
  allowPatterns: string[];
  denyPatterns: string[];
}

/** Gateway (shared channel + router) config from GET /api/gateway. */
export interface GatewayInfo {
  routerHost: string;
  routerPort: number;
  /** Shared Channel Service tunnel; `secretSet` indicates a secret is stored. */
  channel: { serverUrl: string; channelId: string; secretSet: boolean } | null;
  /** Device-wide default approval policy, or null when agents always ask. */
  approval: ApprovalPolicy | null;
  status: GatewayRouterStatus;
}

export interface CreateInstanceInput {
  id: string;
  engine?: string;
  cwd: string;
  label?: string;
  port?: number;
  host?: string;
  baseUrl?: string;
  extraArgs?: string[];
  tunnel?: TunnelConfig;
  envVars?: Record<string, string>;
}

export interface UpdateInstanceInput {
  label?: string;
  host?: string;
  baseUrl?: string;
  cwd?: string;
  extraArgs?: string[];
  tunnel?: TunnelConfig;
  clearTunnel?: boolean;
  envVars?: Record<string, string>;
  clearEnvVars?: boolean;
  approval?: ApprovalPolicy;
  clearApproval?: boolean;
}
