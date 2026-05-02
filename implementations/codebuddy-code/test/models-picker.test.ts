/**
 * /model picker unit tests — exercises CodeBuddyCodeAgent's
 * `onSlashCommand` / `refreshModelsCache` / `switchModel` without
 * standing up a WebSocket.
 *
 * The real data path uses the v2 `createSession().getAvailableModels()`
 * API (NOT `query().supportedModels()` — that one reads an empty field).
 * We mock `unstable_v2_createSession` so the warmup runs without talking
 * to the actual CodeBuddy CLI.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface FakeSession {
  connect: ReturnType<typeof vi.fn>;
  getAvailableModels: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

// Mutable refs the tests can update before constructing an agent.
const sessionState = {
  models: [] as Array<{ modelId: string; name: string; description?: string }>,
  callCount: 0,
};

vi.mock('@tencent-ai/agent-sdk', () => ({
  query: () => ({
    [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true }) }),
    connect: async () => {},
    return: async () => ({ done: true }),
  }),
  unstable_v2_createSession: () => {
    sessionState.callCount += 1;
    const fake: FakeSession = {
      connect: vi.fn().mockResolvedValue(undefined),
      getAvailableModels: vi.fn().mockResolvedValue(sessionState.models),
      close: vi.fn(),
    };
    return fake;
  },
}));

import { CodeBuddyCodeAgent } from '../src/agent.js';

let tmpDir: string;
let agent: CodeBuddyCodeAgent | undefined;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'shepaw-cb-models-'));
  sessionState.models = [];
  sessionState.callCount = 0;
});

afterEach(async () => {
  if (agent !== undefined) {
    await agent.close().catch(() => undefined);
    agent = undefined;
  }
  await rm(tmpDir, { recursive: true, force: true });
});

function makeAgent(opts: { model?: string } = {}): CodeBuddyCodeAgent {
  return new CodeBuddyCodeAgent({
    name: 'Test',
    token: '',
    cwd: tmpDir,
    model: opts.model,
    sessionStoreOptions: { path: join(tmpDir, 'sessions.json') },
    pendingMarkerOptions: { path: join(tmpDir, 'pending.json') },
    patternRuleStoreOptions: {
      sessionRulesPath: join(tmpDir, 'session-rules.json'),
      globalRulesPath: join(tmpDir, 'global-rules.json'),
    },
    peersPath: join(tmpDir, 'peers.json'),
  });
}

describe('CodeBuddyCodeAgent — /model warmup & switch', () => {
  it('onModelsList maps { modelId, name } → { value, display_name } and includes current', async () => {
    sessionState.models = [
      { modelId: 'm-a', name: 'Model A', description: 'Alpha' },
      { modelId: 'm-b', name: 'Model B' },
    ];
    agent = makeAgent({ model: 'm-a' });

    const result = await agent.onModelsList({});
    expect(result.current).toBe('m-a');
    expect(result.models).toEqual([
      { value: 'm-a', display_name: 'Model A', description: 'Alpha' },
      { value: 'm-b', display_name: 'Model B', description: '' },
    ]);
    expect(sessionState.callCount).toBe(1);
  });

  it('5-min TTL cache skips the second createSession call', async () => {
    sessionState.models = [{ modelId: 'm-a', name: 'A' }];
    agent = makeAgent();

    await agent.onModelsList({});
    await agent.onModelsList({});
    expect(sessionState.callCount).toBe(1);
  });

  it('onModelsSetCurrent validates against cache and updates current', async () => {
    sessionState.models = [
      { modelId: 'm-a', name: 'A' },
      { modelId: 'm-b', name: 'B' },
    ];
    agent = makeAgent({ model: 'm-a' });

    const resp = await agent.onModelsSetCurrent({ model: 'm-b' });
    expect(resp).toEqual({ model: 'm-b', display_name: 'B' });

    const list = await agent.onModelsList({});
    expect(list.current).toBe('m-b');
  });

  it('onModelsSetCurrent throws on unknown model', async () => {
    sessionState.models = [{ modelId: 'm-a', name: 'A' }];
    agent = makeAgent();

    await expect(agent.onModelsSetCurrent({ model: 'bogus' })).rejects.toThrow(
      'Unknown model: bogus',
    );
  });
});
