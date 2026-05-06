// Shared types mirroring the API responses

export type AgentEngine = 'codebuddy' | 'claude-code' | 'codex' | 'opencode';

export interface TunnelConfig {
  serverUrl: string;
  channelId: string;
  secret: string;
}

/**
 * Hub-level metadata returned by GET /api/projects/meta.
 * credentialHints contains masked (display-only) values for pre-filling forms.
 */
export interface HubMeta {
  lastTunnelServerUrl: string | null;
  /** Masked hint for the last-used tunnel secret (e.g. "hmac***3b2a") */
  lastTunnelSecretHint: string | null;
  /** Per-engine, per-key masked credential hints (e.g. "sk-an***789") */
  credentialHints: Partial<Record<AgentEngine, Record<string, string>>>;
}

export interface ProjectStatus {
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  stoppedAt: string | null;
  lastResult: 'graceful' | 'hard' | 'crashed' | null;
}

export interface Project {
  id: string;
  label: string;
  engine: AgentEngine;
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
  status: ProjectStatus;
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

export interface SessionResume {
  sessionId: string;
  message?: string;
  history?: ConversationMessage[];
}

export interface CreateProjectInput {
  id: string;
  engine?: AgentEngine;
  cwd: string;
  label?: string;
  port?: number;
  host?: string;
  baseUrl?: string;
  extraArgs?: string[];
  tunnel?: TunnelConfig;
  envVars?: Record<string, string>;
}

export interface UpdateProjectInput {
  label?: string;
  host?: string;
  baseUrl?: string;
  cwd?: string;
  extraArgs?: string[];
  tunnel?: TunnelConfig;
  clearTunnel?: boolean;
  envVars?: Record<string, string>;
  clearEnvVars?: boolean;
}
