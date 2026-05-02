/**
 * Step 4: /model picker unit tests for ClaudeCodeAgent — mirror of the
 * codebuddy-code tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true }) }),
    connect: async () => {},
    supportedModels: async () => [],
    return: async () => ({ done: true }),
  }),
}));

import { ClaudeCodeAgent } from '../src/agent.js';

function makeFakeQueryFn(
  models: Array<{ value: string; displayName: string; description: string }>,
) {
  const record = { callCount: 0, lastOptions: undefined as unknown };
  const queryFn = vi.fn().mockImplementation(((params: { options: unknown }) => {
    record.callCount += 1;
    record.lastOptions = params.options;
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      supportedModels: vi.fn().mockResolvedValue(models),
      return: vi.fn().mockResolvedValue({ done: true }),
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.resolve({ done: true, value: undefined }),
        };
      },
    };
  }) as (params: unknown) => unknown);
  return { queryFn, record };
}

let tmpDir: string;
let agent: ClaudeCodeAgent | undefined;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'shepaw-cc-models-'));
});

afterEach(async () => {
  if (agent !== undefined) {
    await agent.close().catch(() => undefined);
    agent = undefined;
  }
  await rm(tmpDir, { recursive: true, force: true });
});

function makeAgent(
  queryFn: (params: unknown) => unknown,
  opts: { model?: string } = {},
): ClaudeCodeAgent {
  return new ClaudeCodeAgent({
    name: 'Test',
    cwd: tmpDir,
    model: opts.model,
    queryFn: queryFn as never,
    sessionStoreOptions: { path: join(tmpDir, 'sessions.json') },
    pendingMarkerOptions: { path: join(tmpDir, 'pending.json') },
    patternRuleStoreOptions: {
      sessionRulesPath: join(tmpDir, 'session-rules.json'),
      globalRulesPath: join(tmpDir, 'global-rules.json'),
    },
    peersPath: join(tmpDir, 'peers.json'),
  });
}

describe('ClaudeCodeAgent — /model warmup & switch', () => {
  it('onModelsList maps displayName → display_name and seeds current from cfg', async () => {
    const { queryFn } = makeFakeQueryFn([
      { value: 'claude-sonnet-4-5', displayName: 'Sonnet 4.5', description: 'Balanced' },
      { value: 'claude-opus-4-7', displayName: 'Opus 4.7', description: 'Smartest' },
    ]);
    agent = makeAgent(queryFn, { model: 'claude-sonnet-4-5' });

    const result = await agent.onModelsList({});
    expect(result.current).toBe('claude-sonnet-4-5');
    expect(result.models).toEqual([
      { value: 'claude-sonnet-4-5', display_name: 'Sonnet 4.5', description: 'Balanced' },
      { value: 'claude-opus-4-7', display_name: 'Opus 4.7', description: 'Smartest' },
    ]);
  });

  it('TTL cache skips second query within 5min', async () => {
    const { queryFn, record } = makeFakeQueryFn([
      { value: 'm-a', displayName: 'A', description: 'd' },
    ]);
    agent = makeAgent(queryFn);
    await agent.onModelsList({});
    await agent.onModelsList({});
    expect(record.callCount).toBe(1);
  });

  it('onModelsSetCurrent validates and updates', async () => {
    const { queryFn } = makeFakeQueryFn([
      { value: 'm-a', displayName: 'A', description: 'd' },
      { value: 'm-b', displayName: 'B', description: 'd' },
    ]);
    agent = makeAgent(queryFn);

    const resp = await agent.onModelsSetCurrent({ model: 'm-b' });
    expect(resp).toEqual({ model: 'm-b', display_name: 'B' });
    const list = await agent.onModelsList({});
    expect(list.current).toBe('m-b');
  });

  it('onModelsSetCurrent throws on unknown model', async () => {
    const { queryFn } = makeFakeQueryFn([
      { value: 'm-a', displayName: 'A', description: 'd' },
    ]);
    agent = makeAgent(queryFn);
    await expect(agent.onModelsSetCurrent({ model: 'bogus' })).rejects.toThrow(
      'Unknown model: bogus',
    );
  });
});
