import { describe, expect, it } from 'vitest';

import type { GroupChatContext } from 'shepaw-acp-sdk';
import { resolveHubStoreBase } from '../src/hub-store-env.js';
import { resolvePeerStoreMcpServers } from '../src/peer-store-mcp-resolve.js';

const groupContext: GroupChatContext = {
  group_id: 'group_abc',
  group_name: '测试群',
  members: [
    { id: 'a1', name: 'She', type: 'agent', status: 'online' },
    { id: 'a2', name: 'Coder', type: 'agent', status: 'online' },
  ],
  workspace_uri: 'store://workspaces/hubdev/group_group_abc/shared',
};

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
    expect(resolvePeerStoreMcpServers(undefined, {})).toEqual([]);
  });

  it('skips when nexuspouch root present unless force', () => {
    expect(
      resolvePeerStoreMcpServers(undefined, {
        SHEPAW_PEER_STORE: '1',
        NEXUSPOUCH_ROOT: '/data',
      }),
    ).toEqual([]);
  });

  it('builds entry when peer store enabled', () => {
    const servers = resolvePeerStoreMcpServers(undefined, {
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
    // Non-group turns carry no group env → group tools stay disabled.
    expect(s.env.some((e) => e.name === 'GROUP_ID')).toBe(false);
  });

  it('respects SHEPAW_PEER_STORE_MCP=off', () => {
    expect(
      resolvePeerStoreMcpServers(undefined, {
        SHEPAW_PEER_STORE: '1',
        SHEPAW_PEER_STORE_MCP: 'off',
      }),
    ).toEqual([]);
  });

  it('appends group env for group-task turns (enables group tools)', () => {
    const servers = resolvePeerStoreMcpServers(
      { shepawSessionId: 'group_session_1', groupContext },
      {
        SHEPAW_PEER_STORE: '1',
        SHEPAW_PEER_STORE_MCP_SCRIPT: '/tmp/peer-store-mcp.js',
      },
    );
    expect(servers).toHaveLength(1);
    const env = Object.fromEntries(
      servers[0]!.env.map((e) => [e.name, e.value]),
    );
    expect(env.GROUP_ID).toBe('group_abc');
    expect(env.GROUP_SESSION_ID).toBe('group_session_1');
    expect(env.GROUP_WORKSPACE_ROOT).toBe('group_group_abc');
    expect(env.GROUP_MEMBER_NAMES).toBe('She,Coder');
  });
});
