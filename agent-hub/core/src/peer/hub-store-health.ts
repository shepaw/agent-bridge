/**
 * Live probe of the hub-local peer store HTTP API (`GET /api/v1/health`).
 *
 * Used by agent_manage list so paired apps can tell whether `shepaw store`
 * shim targets a reachable store surface before dispatching store-write tasks.
 */

import { DEFAULT_PEER_PORT, loadOrCreateHubConfig } from '../config.js';

export interface HubStoreHealthSnapshot {
  readonly ok: boolean;
  readonly device?: string;
}

export async function probeHubStoreHealth(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 2000,
): Promise<HubStoreHealthSnapshot> {
  const cfg = loadOrCreateHubConfig();
  const port = cfg.peer?.port ?? DEFAULT_PEER_PORT;
  const url = `http://127.0.0.1:${port}/api/v1/health`;
  try {
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false };
    const body = (await res.json()) as { device?: string; ok?: boolean };
    if (body.ok === false) return { ok: false };
    const device =
      typeof body.device === 'string' && body.device.trim().length > 0
        ? body.device.trim().toLowerCase()
        : undefined;
    return { ok: true, device };
  } catch {
    return { ok: false };
  }
}
