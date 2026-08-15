import { t } from '../i18n/index.js';
import type {
  CreateCustomEngineInput,
  CreateInstanceInput,
  CreateInstanceResult,
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
  StoreHealth,
  StoreListResult,
  StoreMappingsResult,
  StoreRootsResult,
  StoreRecentResult,
  StoreReadResult,
  StoreWriteResult,
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

/** Whether the Hub API requires a Bearer token (public /api/health probe). */
export async function fetchHubAuthRequired(): Promise<boolean> {
  const res = await fetch('/api/health');
  const body = (await res.json()) as { authRequired?: boolean };
  return Boolean(body.authRequired);
}

/** Validate a token against a protected endpoint. */
export async function verifyHubAuthToken(
  token: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch('/api/instances', {
    headers: { Authorization: `Bearer ${token.trim()}` },
  });
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: body.error ?? t('auth.verifyFailed', { status: res.status }) };
}

/**
 * Remove a legacy `?token=` from the address bar without persisting it.
 * Tokens must be entered in the dashboard UI (localStorage), not via URL.
 */
export function stripHubAuthTokenFromUrl(
  search: string = typeof window !== 'undefined' ? window.location.search : '',
): void {
  if (typeof window === 'undefined') return;
  try {
    const params = new URLSearchParams(search);
    if (!params.has('token')) return;
    params.delete('token');
    const next = params.toString();
    const url = `${window.location.pathname}${next ? `?${next}` : ''}${window.location.hash}`;
    window.history.replaceState(null, '', url);
  } catch {
    // ignore
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
  const text = await res.text();
  let body: T | { error?: string } | null = null;
  if (text) {
    try {
      body = JSON.parse(text) as T | { error?: string };
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    if (res.status === 413) {
      throw new Error(t('store.uploadFail'));
    }
    const msg =
      (body && typeof body === 'object' && 'error' in body && body.error)
        ? String(body.error)
        : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}

// ── Instances ──────────────────────────────────────────────────────

export const api = {
  instances: {
    list: (): Promise<Instance[]> => request('/instances'),

    get: (id: string): Promise<Instance> => request(`/instances/${id}`),

    /** Get hub-level metadata: lastTunnelServerUrl and credential hints. */
    meta: (): Promise<HubMeta> => request('/instances/meta'),

    create: (input: CreateInstanceInput): Promise<CreateInstanceResult> =>
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

  store: {
    health: (): Promise<StoreHealth> => request('/store/health'),

    roots: (): Promise<StoreRootsResult> => request('/store/roots'),

    recent: (opts?: {
      device?: string;
      spaces?: string[];
      prefix?: string;
      limit?: number;
    }): Promise<StoreRecentResult> => {
      const q = new URLSearchParams();
      if (opts?.device) q.set('device', opts.device);
      if (opts?.spaces?.length) q.set('spaces', opts.spaces.join(','));
      if (opts?.prefix) q.set('prefix', opts.prefix);
      if (opts?.limit) q.set('limit', String(opts.limit));
      const qs = q.toString();
      return request(`/store/recent${qs ? `?${qs}` : ''}`);
    },

    mappings: (): Promise<StoreMappingsResult> => request('/store/mappings'),

    list: (uri: string, depth = 1): Promise<StoreListResult> =>
      request(`/store/list?uri=${encodeURIComponent(uri)}&depth=${depth}`),

    meta: (uri: string): Promise<Record<string, unknown>> =>
      request(`/store/meta?uri=${encodeURIComponent(uri)}`),

    read: (uri: string): Promise<StoreReadResult> =>
      request(`/store/read?uri=${encodeURIComponent(uri)}`),

    write: (input: {
      uri: string;
      content?: string;
      contentBase64?: string;
    }): Promise<StoreWriteResult> =>
      request('/store/write', { method: 'POST', body: JSON.stringify(input) }),

    remove: (uri: string): Promise<{ ok: boolean }> =>
      request(`/store/entry?uri=${encodeURIComponent(uri)}`, { method: 'DELETE' }),

    copy: (fromUri: string, toUri: string): Promise<{ ok: boolean; uri: string }> =>
      request('/store/copy', { method: 'POST', body: JSON.stringify({ fromUri, toUri }) }),

    move: (fromUri: string, toUri: string): Promise<{ ok: boolean; uri: string }> =>
      request('/store/move', { method: 'POST', body: JSON.stringify({ fromUri, toUri }) }),

    reveal: (uri: string): Promise<{ ok: boolean; path: string; kind: 'dir' | 'file' }> =>
      request('/store/reveal', { method: 'POST', body: JSON.stringify({ uri }) }),

    /** Raw download URL (same-origin; auth via Bearer header not possible for <a download>). */
    rawUrl: (uri: string): string =>
      `${BASE}/store/read?uri=${encodeURIComponent(uri)}&raw=1`,
  },
};
