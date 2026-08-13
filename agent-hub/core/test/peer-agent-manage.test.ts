import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { addInstance, isInstanceEnabled, loadOrCreateHubConfig } from '../src/config.js';
import { handleAgentManage } from '../src/peer/peer-agent-manage.js';

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'shepaw-agent-manage-'));
  prevHome = process.env.SHEPAW_HUB_HOME;
  process.env.SHEPAW_HUB_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.SHEPAW_HUB_HOME;
  else process.env.SHEPAW_HUB_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe('handleAgentManage', () => {
  it('lists instances and can disable / re-enable them', async () => {
    let cfg = loadOrCreateHubConfig();
    cfg = addInstance(cfg, {
      id: 'alpha',
      label: 'Alpha',
      engine: 'claude-code',
      cwd: home,
      host: '127.0.0.1',
      port: 18801,
      baseUrl: '',
      extraArgs: [],
      createdAt: new Date().toISOString(),
    });

    const listed = await handleAgentManage({
      request_id: 'r1',
      op: 'list',
    });
    expect(listed.ok).toBe(true);
    const agents = listed.agents as Array<{ id: string; enabled: boolean; manageable: boolean }>;
    expect(agents).toHaveLength(1);
    expect(agents[0]?.id).toBe('alpha');
    expect(agents[0]?.enabled).toBe(true);
    expect(agents[0]?.manageable).toBe(true);

    const disabled = await handleAgentManage({
      request_id: 'r2',
      op: 'set_enabled',
      agent_id: 'alpha',
      enabled: false,
    });
    expect(disabled.ok).toBe(true);
    const afterDisable = loadOrCreateHubConfig();
    expect(isInstanceEnabled(afterDisable.instances[0]!)).toBe(false);

    const startWhileDisabled = await handleAgentManage({
      request_id: 'r3',
      op: 'start',
      agent_id: 'alpha',
    });
    expect(startWhileDisabled.ok).toBe(false);
    expect(String(startWhileDisabled.error)).toMatch(/disabled/i);

    const enabled = await handleAgentManage({
      request_id: 'r4',
      op: 'set_enabled',
      agent_id: 'alpha',
      enabled: true,
    });
    expect(enabled.ok).toBe(true);
    expect(isInstanceEnabled(loadOrCreateHubConfig().instances[0]!)).toBe(true);
  });
});
