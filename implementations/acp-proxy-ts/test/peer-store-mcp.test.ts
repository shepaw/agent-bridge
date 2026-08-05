import { describe, expect, it } from 'vitest';
import { resolveHubStoreBase } from '../src/hub-store-env.js';
import { resolvePeerStoreMcpServers } from '../src/peer-store-mcp-resolve.js';

describe('resolveHubStoreBase', () => {
  it('returns undefined when unset', () => {
    expect(resolveHubStoreBase({})).toBeUndefined();
  });

  it('uses SHEPAW_HUB_STORE_URL', () => {
    expect(
      resolveHubStoreBase({ SHEPAW_HUB_STORE_URL: 'http://127.0.0.1:18792/' }),
    ).toBe('http://127.0.0.1:18792');
  });

  it('expands SHEPAW_PEER_STORE=1', () => {
    expect(resolveHubStoreBase({ SHEPAW_PEER_STORE: '1' })).toBe(
      'http://127.0.0.1:18792',
    );
  });
});

describe('resolvePeerStoreMcpServers', () => {
  it('empty when peer store unset', () => {
    expect(resolvePeerStoreMcpServers({})).toEqual([]);
  });

  it('skips when nexuspouch root present unless force', () => {
    expect(
      resolvePeerStoreMcpServers({
        SHEPAW_PEER_STORE: '1',
        NEXUSPOUCH_ROOT: '/data',
      }),
    ).toEqual([]);
  });

  it('builds entry when peer store enabled', () => {
    const servers = resolvePeerStoreMcpServers({
      SHEPAW_PEER_STORE: '1',
      SHEPAW_PEER_STORE_MCP_SCRIPT: '/tmp/peer-store-mcp.js',
    });
    expect(servers).toHaveLength(1);
    const s = servers[0] as {
      name: string;
      command: string;
      args: string[];
      env: Array<{ name: string; value: string }>;
    };
    expect(s.name).toBe('shepaw-peer-store');
    expect(s.args).toEqual(['/tmp/peer-store-mcp.js']);
    expect(s.env.some((e) => e.name === 'SHEPAW_HUB_STORE_URL')).toBe(true);
  });

  it('respects SHEPAW_PEER_STORE_MCP=off', () => {
    expect(
      resolvePeerStoreMcpServers({
        SHEPAW_PEER_STORE: '1',
        SHEPAW_PEER_STORE_MCP: 'off',
      }),
    ).toEqual([]);
  });
});
