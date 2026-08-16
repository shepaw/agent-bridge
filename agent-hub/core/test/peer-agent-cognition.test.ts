import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadOrCreateHubConfig, saveHubConfig } from '../src/config.js';
import { hubStoreDeviceId } from '../src/peer/agent-store-mapping.js';
import {
  handleAgentMemoryReq,
  handleAgentSoulGet,
  handleAgentSoulSet,
} from '../src/peer/peer-agent-cognition.js';
import { resetPeerLocalStoreForTest } from '../src/peer/peer-local-store.js';

let home: string;
let prevHome: string | undefined;

const PEER_A = 'peer-fingerprint-a';
const PEER_B = 'peer-fingerprint-b';

/** Write the instance directly — addInstance would probe engine availability. */
function addTestInstance(id: string): void {
  const cfg = loadOrCreateHubConfig();
  saveHubConfig(cfg.path, {
    instances: [
      ...cfg.instances,
      {
        id,
        label: id,
        engine: 'claude-code',
        cwd: home,
        host: '127.0.0.1',
        port: 18801,
        baseUrl: '',
        extraArgs: [],
        createdAt: new Date().toISOString(),
        envVars: {},
      },
    ],
    customEngines: [],
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'shepaw-agent-cognition-'));
  prevHome = process.env.SHEPAW_HUB_HOME;
  process.env.SHEPAW_HUB_HOME = home;
  resetPeerLocalStoreForTest(join(home, 'store'));
  addTestInstance('agent-1');
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.SHEPAW_HUB_HOME;
  else process.env.SHEPAW_HUB_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe('handleAgentSoulGet / handleAgentSoulSet', () => {
  it('answers immediately with empty soul for a known agent', () => {
    const resp = handleAgentSoulGet({ agent_id: 'agent-1', request_id: 'r1' });
    expect(resp).toEqual({
      type: 'agent_soul_resp',
      agent_id: 'agent-1',
      request_id: 'r1',
      ok: true,
      soul: '',
      editable: true,
    });
  });

  it('reports not_found for unknown agents instead of dropping the frame', () => {
    const resp = handleAgentSoulGet({ agent_id: 'nope', request_id: 'r2' });
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe('not_found');
    expect(resp.request_id).toBe('r2');
  });

  it('rejects a missing agent_id', () => {
    const resp = handleAgentSoulGet({ request_id: 'r3' });
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe('missing_agent_id');
  });

  it('round-trips a soul through set → get, stripping the export header', () => {
    const set = handleAgentSoulSet({
      agent_id: 'agent-1',
      soul: 'You are Nova.',
      request_id: 's1',
    });
    expect(set).toEqual({
      type: 'agent_soul_set_resp',
      agent_id: 'agent-1',
      request_id: 's1',
      ok: true,
    });

    const got = handleAgentSoulGet({ agent_id: 'agent-1', request_id: 's2' });
    expect(got.ok).toBe(true);
    expect(got.soul).toBe('You are Nova.');
  });

  it('treats an empty set as clearing the soul', () => {
    handleAgentSoulSet({ agent_id: 'agent-1', soul: 'x' });
    const cleared = handleAgentSoulSet({ agent_id: 'agent-1', soul: '   ' });
    expect(cleared.ok).toBe(true);
    const got = handleAgentSoulGet({ agent_id: 'agent-1' });
    expect(got.soul).toBe('');
  });

  it('refuses to write a soul for unknown agents', () => {
    const resp = handleAgentSoulSet({ agent_id: 'nope', soul: 'x' });
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe('not_found');
  });
});

describe('handleAgentMemoryReq', () => {
  const entry = {
    memoryContent: 'likes green tea',
    memoryTime: 1720000000000,
    memoryType: 'knowledge',
    memoryKeywords: ['tea', 'drinks'],
    sourceType: 'direct',
    sourceId: 'chan-1',
    createdAt: 0,
    updatedAt: 0,
  };

  it('add → list → query → update → delete → clear', () => {
    const added = handleAgentMemoryReq(PEER_A, {
      request_id: 'm1',
      agent_id: 'agent-1',
      op: 'add',
      entry,
    });
    expect(added.ok).toBe(true);
    expect(added.editable).toBe(true);
    const id = added.memory_id as number;
    expect(id).toBeGreaterThan(0);

    const listed = handleAgentMemoryReq(PEER_A, {
      request_id: 'm2',
      agent_id: 'agent-1',
      op: 'list',
    });
    expect(listed.ok).toBe(true);
    const memories = listed.memories as Array<Record<string, unknown>>;
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({
      memoryId: id,
      memoryContent: 'likes green tea',
      memoryType: 'knowledge',
      memoryKeywords: ['tea', 'drinks'],
    });
    // createdAt defaults to write time; updatedAt is stamped.
    expect(memories[0]?.createdAt).toBeGreaterThan(0);
    expect(memories[0]?.updatedAt).toBeGreaterThan(0);

    const queried = handleAgentMemoryReq(PEER_A, {
      request_id: 'm3',
      agent_id: 'agent-1',
      op: 'query',
      keyword: 'TEA',
    });
    expect((queried.memories as unknown[]).length).toBe(1);

    const missed = handleAgentMemoryReq(PEER_A, {
      request_id: 'm4',
      agent_id: 'agent-1',
      op: 'query',
      keyword: 'coffee',
    });
    expect((missed.memories as unknown[]).length).toBe(0);

    const updated = handleAgentMemoryReq(PEER_A, {
      request_id: 'm5',
      agent_id: 'agent-1',
      op: 'update',
      entry: { ...entry, memoryId: id, memoryContent: 'likes oolong' },
    });
    expect(updated.ok).toBe(true);
    const relisted = handleAgentMemoryReq(PEER_A, {
      request_id: 'm6',
      agent_id: 'agent-1',
      op: 'list',
    });
    expect((relisted.memories as Array<Record<string, unknown>>)[0]?.memoryContent).toBe(
      'likes oolong',
    );

    const deleted = handleAgentMemoryReq(PEER_A, {
      request_id: 'm7',
      agent_id: 'agent-1',
      op: 'delete',
      memory_id: id,
    });
    expect(deleted.ok).toBe(true);
    const empty = handleAgentMemoryReq(PEER_A, {
      request_id: 'm8',
      agent_id: 'agent-1',
      op: 'list',
    });
    expect(empty.memories).toEqual([]);

    handleAgentMemoryReq(PEER_A, {
      request_id: 'm9',
      agent_id: 'agent-1',
      op: 'add',
      entry,
    });
    const cleared = handleAgentMemoryReq(PEER_A, {
      request_id: 'm10',
      agent_id: 'agent-1',
      op: 'clear',
    });
    expect(cleared.ok).toBe(true);
    // next_id resets: the next add allocates id 1 again.
    const readded = handleAgentMemoryReq(PEER_A, {
      request_id: 'm11',
      agent_id: 'agent-1',
      op: 'add',
      entry,
    });
    expect(readded.memory_id).toBe(1);
  });

  it('isolates memories per peer', () => {
    handleAgentMemoryReq(PEER_A, {
      request_id: 'p1',
      agent_id: 'agent-1',
      op: 'add',
      entry,
    });
    const bList = handleAgentMemoryReq(PEER_B, {
      request_id: 'p2',
      agent_id: 'agent-1',
      op: 'list',
    });
    expect(bList.ok).toBe(true);
    expect(bList.memories).toEqual([]);
  });

  it('filters list by memory type', () => {
    handleAgentMemoryReq(PEER_A, {
      request_id: 't1',
      agent_id: 'agent-1',
      op: 'add',
      entry,
    });
    const none = handleAgentMemoryReq(PEER_A, {
      request_id: 't2',
      agent_id: 'agent-1',
      op: 'list',
      type: 'event',
    });
    expect(none.memories).toEqual([]);
    const some = handleAgentMemoryReq(PEER_A, {
      request_id: 't3',
      agent_id: 'agent-1',
      op: 'list',
      type: 'knowledge',
    });
    expect((some.memories as unknown[]).length).toBe(1);
  });

  it('answers error codes instead of hanging', () => {
    expect(
      handleAgentMemoryReq(PEER_A, { request_id: 'e1', agent_id: '', op: 'list' }).error,
    ).toBe('missing_agent_id');
    expect(
      handleAgentMemoryReq(PEER_A, { request_id: 'e2', agent_id: 'nope', op: 'list' }).error,
    ).toBe('not_available');
    expect(
      handleAgentMemoryReq(PEER_A, { request_id: 'e3', agent_id: 'agent-1', op: 'add' }).error,
    ).toBe('invalid_entry');
    expect(
      handleAgentMemoryReq(PEER_A, {
        request_id: 'e4',
        agent_id: 'agent-1',
        op: 'update',
        entry,
      }).error,
    ).toBe('missing_memory_id');
    expect(
      handleAgentMemoryReq(PEER_A, {
        request_id: 'e5',
        agent_id: 'agent-1',
        op: 'delete',
      }).error,
    ).toBe('missing_memory_id');
    expect(
      handleAgentMemoryReq(PEER_A, { request_id: 'e6', agent_id: 'agent-1', op: 'nuke' }).error,
    ).toBe('unsupported');
  });

  it('stores cognition under the hub device tree in the app layout', () => {
    handleAgentSoulSet({ agent_id: 'agent-1', soul: 'x' });
    const device = hubStoreDeviceId();
    const expected = join(home, 'store', device, 'cognition', 'agent-1', 'soul.md');
    expect(existsSync(expected)).toBe(true);
  });
});
