import { describe, expect, it } from 'vitest';
import { resolveNexuspouchMcpServers } from '../src/nexuspouch-mcp.js';

describe('resolveNexuspouchMcpServers', () => {
  it('returns empty when root unset', () => {
    expect(resolveNexuspouchMcpServers({})).toEqual([]);
  });

  it('respects NEXUSPOUCH_MCP=off', () => {
    expect(
      resolveNexuspouchMcpServers({
        NEXUSPOUCH_ROOT: '/data',
        NEXUSPOUCH_MCP: 'off',
      }),
    ).toEqual([]);
  });

  it('builds stdio mcp entry from root + token', () => {
    const servers = resolveNexuspouchMcpServers({
      NEXUSPOUCH_ROOT: '/var/lib/nexuspouch',
      NEXUSPOUCH_ADMIN_TOKEN: 'tok',
      NEXUSPOUCH_BIN: '/usr/local/bin/nexuspouch',
    });
    expect(servers).toHaveLength(1);
    const s = servers[0] as {
      name: string;
      command: string;
      args: string[];
      env: Array<{ name: string; value: string }>;
    };
    expect(s.name).toBe('nexuspouch');
    expect(s.command).toBe('/usr/local/bin/nexuspouch');
    expect(s.args).toEqual([
      'mcp',
      '--root',
      '/var/lib/nexuspouch',
      '--admin-token',
      'tok',
    ]);
    expect(s.env).toEqual([{ name: 'NEXUSPOUCH_ADMIN_TOKEN', value: 'tok' }]);
  });
});
