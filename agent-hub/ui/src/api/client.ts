import type {
  CreateCustomEngineInput,
  CreateProjectInput,
  EnrollToken,
  EngineInfo,
  HubMeta,
  Peer,
  Project,
  StoredSession,
  UpdateProjectInput,
} from './types.js';

const BASE = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const body = await res.json() as T | { error: string };
  if (!res.ok) throw new Error((body as { error: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

// ── Projects ──────────────────────────────────────────────────────

export const api = {
  projects: {
    list: (): Promise<Project[]> => request('/projects'),

    get: (id: string): Promise<Project> => request(`/projects/${id}`),

    /** Get hub-level metadata: lastTunnelServerUrl and credential hints. */
    meta: (): Promise<HubMeta> => request('/projects/meta'),

    create: (input: CreateProjectInput): Promise<Project> =>
      request('/projects', { method: 'POST', body: JSON.stringify(input) }),

    update: (id: string, patch: UpdateProjectInput): Promise<Project> =>
      request(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

    remove: (id: string): Promise<void> =>
      request(`/projects/${id}`, { method: 'DELETE' }),

    start: (id: string): Promise<{ pid: number; alreadyRunning: boolean }> =>
      request(`/projects/${id}/start`, { method: 'POST' }),

    stop: (id: string): Promise<{ result: 'graceful' | 'hard' | 'not-running' }> =>
      request(`/projects/${id}/stop`, { method: 'POST' }),
  },

  peers: {
    list: (projectId: string): Promise<Peer[]> => request(`/projects/${projectId}/peers`),

    add: (projectId: string, pubkey: string, label?: string): Promise<Peer> =>
      request(`/projects/${projectId}/peers`, {
        method: 'POST',
        body: JSON.stringify({ pubkey, label }),
      }),

    remove: (projectId: string, fingerprint: string): Promise<void> =>
      request(`/projects/${projectId}/peers/${fingerprint}`, { method: 'DELETE' }),
  },

  envvars: {
    list: (projectId: string): Promise<{ key: string; value: string }[]> =>
      request(`/projects/${projectId}/envvars`),

    set: (projectId: string, key: string, value: string): Promise<{ ok: boolean; key: string }> =>
      request(`/projects/${projectId}/envvars/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
      }),

    remove: (projectId: string, key: string): Promise<void> =>
      request(`/projects/${projectId}/envvars/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  },

  enroll: {
    list: (projectId: string): Promise<EnrollToken[]> => request(`/projects/${projectId}/enroll`),

    mint: (projectId: string, opts?: { label?: string; ttlMinutes?: number; baseUrl?: string }): Promise<EnrollToken> =>
      request(`/projects/${projectId}/enroll`, {
        method: 'POST',
        body: JSON.stringify(opts ?? {}),
      }),

    revoke: (projectId: string, code: string): Promise<void> =>
      request(`/projects/${projectId}/enroll/${code}`, { method: 'DELETE' }),
  },

  sessions: {
    list: (projectId: string): Promise<{ sessions: StoredSession[] }> =>
      request(`/projects/${projectId}/sessions`),

    remove: (projectId: string, shepawSessionId: string): Promise<void> =>
      request(`/projects/${projectId}/sessions/${encodeURIComponent(shepawSessionId)}`, {
        method: 'DELETE',
      }),
  },

  engines: {
    list: (): Promise<{ engines: EngineInfo[] }> => request('/engines'),

    create: (input: CreateCustomEngineInput): Promise<{ engine: EngineInfo }> =>
      request('/engines', { method: 'POST', body: JSON.stringify(input) }),

    remove: (id: string): Promise<void> =>
      request(`/engines/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
};
