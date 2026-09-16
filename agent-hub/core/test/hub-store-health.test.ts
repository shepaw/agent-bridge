import { afterEach, describe, expect, it, vi } from 'vitest';

import { probeHubStoreHealth } from '../src/peer/hub-store-health.js';

describe('probeHubStoreHealth', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns ok with device when health responds', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ ok: true, device: 'abc123' }),
    );
    const snap = await probeHubStoreHealth(fetchImpl as typeof fetch);
    expect(snap.ok).toBe(true);
    expect(snap.device).toBe('abc123');
  });

  it('returns not ok on network failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const snap = await probeHubStoreHealth(fetchImpl as typeof fetch);
    expect(snap.ok).toBe(false);
  });
});
