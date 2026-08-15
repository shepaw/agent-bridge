// Shared types mirroring the API responses

export type AgentEngine = string;

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
  /** Native ACP session mode for this engine (e.g. auto, agent, acceptEdits). */
  sessionMode?: string;
  /** Only key names are exposed — values are never returned by the API. */
  envVarKeys: string[];
  status: InstanceStatus;
  /** Auto-mapped store URIs for workspace + agent private space. */
  store?: {
    deviceId: string;
    workspaceUri: string;
    agentUri: string;
  };
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
  description?: string;
  acpCommand: string;
  builtin: boolean;
  /** True when an operator has disabled this engine. */
  disabled?: boolean;
  /** Engine-default env var key names (values never exposed). */
  envVarKeys?: string[];
  /** False when disabled or upstream CLI is missing. */
  available?: boolean;
  unavailableReason?: string | null;
  sessionModes?: Array<{ id: string; name: string; description: string }>;
  defaultSessionMode?: string;
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
}

export interface MaskedEnvVar {
  key: string;
  /** Masked for secrets; plaintext for non-sensitive keys (URL, model, …). */
  value: string;
  /** True when the key looks like a secret (KEY / TOKEN / SECRET / …). */
  sensitive: boolean;
}

export interface EngineSetupStep {
  title: string;
  description: string;
  command?: string;
}

export interface EngineEnvVarHint {
  key: string;
  description: string;
  optional?: boolean;
}

export interface EngineSetupGuide {
  engineId: string;
  summary: string;
  acpCommand: string;
  docsUrl?: string;
  steps: EngineSetupStep[];
  installCommand?: string;
  checkBinary: string;
  requiredEnvVars?: EngineEnvVarHint[];
  installable: boolean;
  platform?: 'darwin' | 'linux' | 'win32';
  platformLabel?: string;
}

export interface EngineInstallStatus {
  installed: boolean;
  binaryPath: string | null;
  version: string | null;
  checkError: string | null;
}

export interface EngineSetupResponse {
  guide: EngineSetupGuide;
  status: EngineInstallStatus;
  disabled: boolean;
  platform: 'darwin' | 'linux' | 'win32';
  platformLabel: string;
}

export interface EngineInstallResponse {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: EngineInstallStatus;
  enabled: boolean;
}

/** Runtime status of the device peer service. */
export interface PeerServiceStatus {
  running: boolean;
  pid: number | null;
  port: number;
  host: string;
  startedAt: string | null;
}

/** A device paired with the hub via the shepaw://peer flow. */
export interface PairedPeer {
  id: string;
  deviceName: string;
  deviceId: string;
  publicKey: string;
  fingerprint: string;
  localEndpoint?: string;
  channelEndpoint?: string;
  pairedAt: string;
}

/** Result of POST /api/peer/pair — mint a shepaw://peer QR. */
export interface PeerPairingResult {
  code: string;
  qrPayload: string;
  expiresAt: number;
  localEndpoint: string;
  /** WAN endpoint via shared channel; present when gateway tunnel is configured. */
  channelEndpoint?: string;
  fingerprint: string;
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

/** Live session from agent.sessions.list on the instance gateway. */
export interface LiveSession {
  session_id: string;
  title?: string;
  updated_at?: string;
  cwd?: string;
}

/** One message from agent.sessions.history. */
export interface SessionHistoryMessage {
  role: 'user' | 'agent';
  content: string;
  message_id?: string;
  /** ISO-8601 original send time when known. */
  created_at?: string;
}

/** Peer-pushed attachment stored under instances/<id>/peer-attachments/. */
export interface PeerAttachment {
  name: string;
  fileName: string;
  size: number;
  modifiedAt: string;
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

/** Gateway (shared channel + router) config from GET /api/gateway. */
export interface GatewayInfo {
  routerHost: string;
  routerPort: number;
  /** Shared Channel Service tunnel; `secretSet` indicates a secret is stored. */
  channel: { serverUrl: string; channelId: string; secretSet: boolean } | null;
  status: GatewayRouterStatus;
}

export interface CreateInstanceInput {
  /** Optional; server always allocates a collision-free UUID. */
  id?: string;
  engine?: string;
  cwd: string;
  label?: string;
  port?: number;
  host?: string;
  baseUrl?: string;
  extraArgs?: string[];
  tunnel?: TunnelConfig;
  envVars?: Record<string, string>;
  sessionMode?: string;
  /** Default true: spawn the gateway after registering. Pass false to register only. */
  start?: boolean;
}

/** POST /api/instances — instance plus optional start failure (instance still exists). */
export interface CreateInstanceResult extends Instance {
  startError?: string;
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
  sessionMode?: string;
}

/** Directory entry from GET /api/fs/browse. */
export interface FsBrowseEntry {
  name: string;
  path: string;
  type: 'dir';
}

/** Response from GET /api/fs/browse. */
export interface FsBrowseResult {
  path: string;
  parent: string | null;
  entries: FsBrowseEntry[];
}

/** Entry from GET /api/store/list. */
export interface StoreEntry {
  path: string;
  size: number;
  sha256: string;
  mtime: number;
  kind?: 'file' | 'dir';
}

export interface StoreHealth {
  ok: boolean;
  deviceId: string;
  storeRoot: string;
  spaces: string[];
  localBrowserSpaces?: string[];
  peerBrowserSpaces?: string[];
}

export interface StoreMapping {
  instanceId: string;
  label: string;
  engine: string;
  cwd: string;
  deviceId: string;
  workspaceUri: string;
  agentUri: string;
}

export interface StoreMappingsResult {
  deviceId: string;
  mappings: StoreMapping[];
}

export interface StoreRootsResult {
  local: {
    kind: 'local';
    label: string;
    deviceId: string;
    writable: boolean;
    storeRoot: string;
    spaces: string[];
  };
  peers: Array<{
    id: string;
    deviceName: string;
    deviceId: string;
    fingerprint: string;
    pairedAt: string;
    writable: boolean;
    spaces: string[];
    rootUri: string;
  }>;
  agents: StoreMapping[];
  peerService: {
    running: boolean;
    port: number;
    host: string;
  };
}

export interface StoreListResult {
  uri: string;
  space: string;
  device: string;
  path: string;
  parent: string | null;
  writable?: boolean;
  entries: StoreEntry[];
}

export interface StoreRecentEntry {
  uri: string;
  space: string;
  device: string;
  path: string;
  size: number;
  sha256: string;
  mtime: number;
  kind: 'file';
}

export interface StoreRecentResult {
  device: string;
  writable: boolean;
  entries: StoreRecentEntry[];
}

export interface StoreReadResult {
  uri: string;
  size: number;
  sha256: string;
  mtime?: number;
  writable?: boolean;
  contentBase64: string;
}

export interface StoreWriteResult {
  ok: boolean;
  uri: string;
  size: number;
  sha256: string;
}
