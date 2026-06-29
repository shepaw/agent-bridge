import { describe, expect, it } from 'vitest';

import { discardLoadReplayUpdates } from '../src/session-lifecycle.js';

function mockSession(updates: Array<{ kind: 'update'; update: { sessionUpdate: string } } | { kind: 'stop' }>) {
  let i = 0;
  return {
    async nextUpdate() {
      const next = updates[i++];
      if (next === undefined) {
        return new Promise(() => {});
      }
      if (next.kind === 'stop') {
        return { kind: 'stop' as const, stopReason: 'end_turn' };
      }
      return {
        kind: 'update' as const,
        update: next.update,
      };
    },
  };
}

describe('discardLoadReplayUpdates', () => {
  it('drains replay chunks until idle', async () => {
    const session = mockSession([
      { kind: 'update', update: { sessionUpdate: 'agent_message_chunk' } },
      { kind: 'update', update: { sessionUpdate: 'agent_message_chunk' } },
      { kind: 'stop' },
    ]);

    const count = await discardLoadReplayUpdates(session as never, {
      idleMs: 50,
      pollMs: 20,
      maxMs: 1000,
    });

    expect(count).toBe(2);
  });

  it('stops on non-replay update', async () => {
    const session = mockSession([
      { kind: 'update', update: { sessionUpdate: 'agent_message_chunk' } },
      { kind: 'update', update: { sessionUpdate: 'config_option_update' } },
    ]);

    const count = await discardLoadReplayUpdates(session as never, {
      idleMs: 50,
      pollMs: 20,
      maxMs: 1000,
    });

    expect(count).toBe(1);
  });
});
