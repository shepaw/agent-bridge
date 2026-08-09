import type {
  ApprovalPolicy,
  CreateCustomEngineInput,
  CreateInstanceInput,
  EnrollToken,
  EngineInfo,
  EngineInstallResponse,
  EngineOverridePatch,
  EngineSetupResponse,
  GatewayInfo,
  GatewayRouterStatus,
  HubAgentCatalogEntry,
  HubMeta,
  HubPairedDevice,
  HubPairingResult,
  MaskedEnvVar,
  PairedPeer,
  Peer,
  PeerAttachment,
  PeerPairingResult,
  PeerServiceStatus,
  Instance,
  StoredSession,
  LiveSession,
  SessionHistoryMessage,
  UpdateCustomEngineInput,
  UpdateInstanceInput,
  FsBrowseResult,
} from './types.js';

const BASE = '/api';
const TOKEN_STORAGE_KEY = 'shepaw_hub_token';

function getAuthToken(): string | undefined {
  try {
    const fromStorage = localStorage.getItem(TOKEN_STORAGE_KEY)?.trim();
    if (fromStorage) return fromStorage;
  } catch {
    // ignore (SSR / private mode)
  }
  return undefined;
}

export function setHubAuthToken(token: string | null): void {
  try {
    if (!token) {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    } else {
      localStorage.setItem(TOKEN_STORAGE_KEY, token.trim());
    }
  } catch {
    // ignore
  }
}

export function getHubAuthToken(): string | undefined {
  return getAuthToken();
}

/**
 * If the page was opened with `?token=...`, persist it and strip the query
 * (avoids leaking the secret via referrer / screenshots of the address bar).
 */
export function bootstrapHubAuthTokenFromUrl(
  search: string = typeof window !== 'undefined' ? window.location.search : '',
): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(search);
    const fromQuery = params.get('token')?.trim();
    if (!fromQuery) return false;
    setHubAuthToken(fromQuery);
    params.delete('token');
    const next = params.toString();
    const url = `${window.location.pathname}${next ? `?${next}` : ''}${window.location.hash}`;
    window.history.replaceState(null, '', url);
    return true;
  } catch {
    return false;
  }
}

function authHeaders(): HeadersInit {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(init?.headers ?? {}),
    },
  });
  const body = await res.json() as T | { error: string };
  if (!res.ok) throw new Error((body as { error: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

// ── Instances ──────────────────────────────────────────────────────

export const api = {
  instances: {
    list: (): Promise<Instance[]> => request('/instances'),

    get: (id: string): Promise<Instance> => request(`/instances/${id}`),

    /** Get hub-level metadata: lastTunnelServerUrl and credential hints. */
    meta: (): Promise<HubMeta> => request('/instances/meta'),

    create: (input: CreateInstanceInput): Promise<Instance> =>
      request('/instances', { method: 'POST', body: JSON.stringify(input) }),

    update: (id: string, patch: UpdateInstanceInput): Promise<Instance> =>
      request(`/instances/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

    remove: (id: string): Promise<void> =>
      request(`/instances/${id}`, { method: 'DELETE' }),

    start: (id: string): Promise<{ pid: number; alreadyRunning: boolean }> =>
      request(`/instances/${id}/start`, { method: 'POST' }),

    stop: (id: string): Promise<{ result: 'graceful' | 'hard' | 'not-running' }> =>
      request(`/instances/${id}/stop`, { method: 'POST' }),

    restartAll: (): Promise<{
      restarted: number;
      failed: number;
      results: Array<{
        id: string;
        wasRunning: boolean;
        stopResult?: 'graceful' | 'hard' | 'not-running';
        startResult?: { pid: number; alreadyRunning: boolean };
        error?: string;
      }>;
    }> => request('/instances/restart-all', { method: 'POST' }),

    setApproval: (id: string, policy: ApprovalPolicy): Promise<Instance> =>
      request(`/instances/${id}/approval`, { method: 'PUT', body: JSON.stringify(policy) }),

    clearApproval: (id: string): Promise<Instance> =>
      request(`/instances/${id}/approval`, { method: 'DELETE' }),
  },

  peers: {
    list: (instanceId: string): Promise<Peer[]> => request(`/instances/${instanceId}/peers`),

    add: (instanceId: string, pubkey: string, label?: string): Promise<Peer> =>
      request(`/instances/${instanceId}/peers`, {
        method: 'POST',
        body: JSON.stringify({ pubkey, label }),
      }),

    remove: (instanceId: string, fingerprint: string): Promise<void> =>
      request(`/instances/${instanceId}/peers/${fingerprint}`, { method: 'DELETE' }),
  },

  envvars: {
    list: (instanceId: string): Promise<{ key: string; value: string }[]> =>
      request(`/instances/${instanceId}/envvars`),

    set: (instanceId: string, key: string, value: string): Promise<{ ok: boolean; key: string }> =>
      request(`/instances/${instanceId}/envvars/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
      }),

    remove: (instanceId: string, key: string): Promise<void> =>
      request(`/instances/${instanceId}/envvars/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  },

  enroll: {
    list: (instanceId: string): Promise<EnrollToken[]> => request(`/instances/${instanceId}/enroll`),

    mint: (instanceId: string, opts?: { label?: string; ttlMinutes?: number; baseUrl?: string }): Promise<EnrollToken> =>
      request(`/instances/${instanceId}/enroll`, {
        method: 'POST',
        body: JSON.stringify(opts ?? {}),
      }),

    revoke: (instanceId: string, code: string): Promise<void> =>
      request(`/instances/${instanceId}/enroll/${code}`, { method: 'DELETE' }),
  },

  sessions: {
    list: (instanceId: string): Promise<{ sessions: StoredSession[] }> =>
      request(`/instances/${instanceId}/sessions`),

    remove: (instanceId: string, shepawSessionId: string): Promise<void> =>
      request(`/instances/${instanceId}/sessions/${encodeURIComponent(shepawSessionId)}`, {
        method: 'DELETE',
      }),
  },

  conversations: {
    list: (instanceId: string): Promise<{ sessions: LiveSession[] }> =>
      request(`/instances/${instanceId}/conversations`),

    history: (
      instanceId: string,
      sessionId: string,
    ): Promise<{ session_id: string; messages: SessionHistoryMessage[] }> =>
      request(
        `/instances/${instanceId}/conversations/${encodeURIComponent(sessionId)}/history`,
      ),
  },

  attachments: {
    list: (instanceId: string): Promise<{ attachments: PeerAttachment[] }> =>
      request(`/instances/${instanceId}/attachments`),

    remove: (instanceId: string, name: string): Promise<void> =>
      request(`/instances/${instanceId}/attachments/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      }),

    clear: (instanceId: string): Promise<{ ok: boolean; deleted: number }> =>
      request(`/instances/${instanceId}/attachments`, { method: 'DELETE' }),
  },

  engines: {
    list: (): Promise<{ engines: EngineInfo[] }> => request('/engines'),

    create: (input: CreateCustomEngineInput): Promise<{ engine: EngineInfo }> =>
      request('/engines', { method: 'POST', body: JSON.stringify(input) }),

    update: (id: string, patch: UpdateCustomEngineInput): Promise<{ engine: EngineInfo }> =>
      request(`/engines/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) }),

    remove: (id: string): Promise<void> =>
      request(`/engines/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    setOverride: (id: string, patch: EngineOverridePatch): Promise<{ ok: boolean }> =>
      request(`/engines/${encodeURIComponent(id)}/override`, { method: 'PUT', body: JSON.stringify(patch) }),

    clearApproval: (id: string): Promise<{ ok: boolean }> =>
      request(`/engines/${encodeURIComponent(id)}/approval`, { method: 'DELETE' }),

    setup: (id: string): Promise<EngineSetupResponse> =>
      request(`/engines/${encodeURIComponent(id)}/setup`),

    install: (id: string): Promise<EngineInstallResponse> =>
      request(`/engines/${encodeURIComponent(id)}/install`, { method: 'POST' }),

    envvars: {
      list: (id: string): Promise<MaskedEnvVar[]> =>
        request(`/engines/${encodeURIComponent(id)}/envvars`),

      set: (id: string, key: string, value: string): Promise<{ ok: boolean; key: string }> =>
        request(`/engines/${encodeURIComponent(id)}/envvars/${encodeURIComponent(key)}`, {
          method: 'PUT',
          body: JSON.stringify({ value }),
        }),

      remove: (id: string, key: string): Promise<{ ok: boolean }> =>
        request(`/engines/${encodeURIComponent(id)}/envvars/${encodeURIComponent(key)}`, { method: 'DELETE' }),
    },
  },

  pair: {
    agents: (): Promise<{ agents: HubAgentCatalogEntry[] }> => request('/pair/agents'),

    devices: (): Promise<{ devices: HubPairedDevice[] }> => request('/pair/devices'),

    removeDevice: (fingerprint: string): Promise<void> =>
      request(`/pair/devices/${fingerprint}`, { method: 'DELETE' }),

    mint: (opts?: {
      label?: string;
      ttlMinutes?: number;
      bootstrapInstanceId?: string;
      baseUrl?: string;
    }): Promise<HubPairingResult> =>
      request('/pair/enroll', { method: 'POST', body: JSON.stringify(opts ?? {}) }),

    revoke: (code: string): Promise<void> =>
      request(`/pair/enroll/${encodeURIComponent(code)}`, { method: 'DELETE' }),
  },

  gateway: {
    get: (): Promise<GatewayInfo> => request('/gateway'),

    setChannel: (input: {
      serverUrl: string;
      channelId: string;
      secret: string;
      routerPort?: number;
    }): Promise<{ ok: boolean }> =>
      request('/gateway/channel', { method: 'PUT', body: JSON.stringify(input) }),

    clearChannel: (): Promise<{ ok: boolean }> =>
      request('/gateway/channel', { method: 'DELETE' }),

    setApproval: (input: ApprovalPolicy): Promise<{ ok: boolean; approval: ApprovalPolicy }> =>
      request('/gateway/approval', { method: 'PUT', body: JSON.stringify(input) }),

    clearApproval: (): Promise<{ ok: boolean }> =>
      request('/gateway/approval', { method: 'DELETE' }),

    start: (): Promise<{ pid: number; alreadyRunning: boolean; status: GatewayRouterStatus }> =>
      request('/gateway/start', { method: 'POST' }),

    stop: (): Promise<{ result: string; status: GatewayRouterStatus }> =>
      request('/gateway/stop', { method: 'POST' }),
  },

  peer: {
    get: (): Promise<{ status: PeerServiceStatus; devices: PairedPeer[] }> => request('/peer'),

    start: (): Promise<{ ok: boolean; status: PeerServiceStatus }> =>
      request('/peer/start', { method: 'POST' }),

    stop: (): Promise<{ ok: boolean; result: string; status: PeerServiceStatus }> =>
      request('/peer/stop', { method: 'POST' }),

    pair: (): Promise<PeerPairingResult> =>
      request('/peer/pair', { method: 'POST' }),

    devices: (): Promise<{ devices: PairedPeer[] }> => request('/peer/devices'),

    removeDevice: (fingerprint: string): Promise<{ ok: boolean; devices: PairedPeer[] }> =>
      request(`/peer/devices/${fingerprint}`, { method: 'DELETE' }),
  },

  fs: {
    browse: (path?: string): Promise<FsBrowseResult> => {
      const q = path !== undefined && path.trim().length > 0
        ? `?path=${encodeURIComponent(path.trim())}`
        : '';
      return request(`/fs/browse${q}`);
    },
  },
};
