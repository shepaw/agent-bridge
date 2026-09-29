import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadOrCreateHubConfig, resolveSheModel, setHubShe } from '../src/config.js';
import { SHE_AGENT_ID } from '../src/peer/pouch-host.js';
import { listAgents } from '../src/peer/peer-agent-host.js';
import { hubStoreDeviceId } from '../src/peer/agent-store-mapping.js';
import { resetPeerLocalStoreForTest } from '../src/peer/peer-local-store.js';
import {
  beginPouchApproval,
  resetPouchApprovalsForTest,
  settlePouchApproval,
} from '../src/peer/pouch-approval.js';
import {
  createLocalPouchSession,
  executeSheTool,
  loadPouchSessions,
  readOrchestrationInbox,
  searchLocalStore,
} from '../src/peer/pouch-disk.js';

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'shepaw-pouch-'));
  prevHome = process.env.SHEPAW_HUB_HOME;
  process.env.SHEPAW_HUB_HOME = home;
  delete process.env.SHEPAW_SHE_BASE_URL;
  delete process.env.SHEPAW_SHE_API_KEY;
  delete process.env.SHEPAW_SHE_MODEL;
  resetPeerLocalStoreForTest(join(home, 'store'));
});

afterEach(() => {
  resetPouchApprovalsForTest();
  if (prevHome === undefined) delete process.env.SHEPAW_HUB_HOME;
  else process.env.SHEPAW_HUB_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe('host pouch', () => {
  it('会话建在本机注册表里', () => {
    const created = createLocalPouchSession({
      kind: 'dm',
      reason: 'context_too_long',
      summary: '接着做登录',
      channel_id: 'dm_old',
      agent_id: 'eng-1',
    });
    expect(created.ok).toBe(true);
    expect(String(created.new_session_id)).toMatch(/^dm_/);
    const saved = loadPouchSessions();
    expect(saved[0]?.title).toBe('接着做登录');
    expect(saved[0]?.previous_channel_id).toBe('dm_old');
  });

  it('惜宝写下的 dispatch 能被本轮读回', async () => {
    const since = Date.now();
    const written = await executeSheTool({
      name: 'group_dispatch',
      args: {
        mode: 'sequential',
        steps: [{ agents: ['Codex'], task: '看日志' }],
      },
      groupId: 'group_abc',
      sessionId: 'sess_1',
    });
    expect(written).toContain('dispatch.json');
    const inbox = readOrchestrationInbox({
      groupId: 'group_abc',
      sessionId: 'sess_1',
      sinceMs: since,
    });
    expect(inbox?.mode).toBe('sequential');
    expect(inbox?.steps?.[0]?.task).toBe('看日志');
  });

  it('search 能找到本机袋子里的正文', () => {
    const device = hubStoreDeviceId();
    const store = resetPeerLocalStoreForTest(join(home, 'store'));
    const abs = store.absPath(device, 'files', 'notes/hello.md');
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, '惜宝记得绿茶叶', 'utf8');
    const found = searchLocalStore({ query: '绿茶叶', deviceId: device });
    expect(found.hits.some((hit) => hit.path === 'notes/hello.md')).toBe(true);
  });

  it('惜宝模型配置落在 hub.json，密钥不明文', () => {
    const cfg = loadOrCreateHubConfig();
    setHubShe(cfg, {
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'local-she',
      apiKey: 'sk-test',
    });
    const loaded = loadOrCreateHubConfig();
    expect(loaded.she?.baseUrl).toBe('http://127.0.0.1:9/v1');
    expect(loaded.she?.model).toBe('local-she');
    expect(loaded.she?.apiKey).not.toContain('sk-test');
    expect(resolveSheModel(loaded)).toMatchObject({
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'local-she',
      apiKey: 'sk-test',
    });
  });

  it('agent 列表里带上惜宝', () => {
    const agents = listAgents();
    const she = agents.find((agent) => agent.id === SHE_AGENT_ID);
    expect(she?.name).toBe('惜宝');
    expect(she?.manageable).toBe(false);
    expect(she?.engine).toBe('she');
  });

  it('审批在主机上等到操作层回传', async () => {
    const pending = beginPouchApproval('appr-1', 1000);
    expect(settlePouchApproval('appr-1', { id: 'allow', label: '允许' })).toBe(true);
    await expect(pending).resolves.toEqual({ id: 'allow', label: '允许' });
  });
});
