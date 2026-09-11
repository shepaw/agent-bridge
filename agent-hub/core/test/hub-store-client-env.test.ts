import { describe, expect, it } from 'vitest';

import { DEFAULT_PEER_PORT } from '../src/config.js';
import { hubStoreClientEnv } from '../src/peer/hub-store-client-env.js';

describe('hubStoreClientEnv', () => {
  it('defaults to Hub peer port 18793, not the App 18792', () => {
    const env = hubStoreClientEnv({});
    expect(DEFAULT_PEER_PORT).toBe(18793);
    expect(env.SHEPAW_PEER_STORE).toBe('1');
    expect(env.SHEPAW_PEER_HOST).toBe('127.0.0.1');
    expect(env.SHEPAW_PEER_PORT).toBe('18793');
    expect(env.SHEPAW_HUB_STORE_URL).toBe('http://127.0.0.1:18793');
  });

  it('follows hub.json peer.port when set', () => {
    const env = hubStoreClientEnv({ peer: { host: '0.0.0.0', port: 19100 } });
    expect(env.SHEPAW_PEER_PORT).toBe('19100');
    expect(env.SHEPAW_HUB_STORE_URL).toBe('http://127.0.0.1:19100');
  });
});
