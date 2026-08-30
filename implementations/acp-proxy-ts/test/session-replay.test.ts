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

  it('keeps waiting through the warm-up before the first replay chunk', async () => {
    // Resume path: the engine answers the request first and the first replay
    // chunk lags behind the idle window. Like the real AsyncQueue, the update
    // is delivered once to whichever nextUpdate() call is pending.
    const session = mockSession([
      { kind: 'update', update: { sessionUpdate: 'agent_message_chunk' } },
    ]);
    const inner = session.nextUpdate.bind(session);
    let firstCall = true;
    session.nextUpdate = async () => {
      if (firstCall) {
        firstCall = false;
        await new Promise((r) => setTimeout(r, 150)); // replay lag > idleMs
      }
      return inner();
    };

    const count = await discardLoadReplayUpdates(session as never, {
      idleMs: 50,
      pollMs: 20,
      maxMs: 2000,
      warmupMs: 300,
    });

    expect(count).toBe(1);
  });

  it('ends quickly when no replay ever arrives despite warm-up', async () => {
    const session = { nextUpdate: () => new Promise(() => {}) };

    const started = Date.now();
    const count = await discardLoadReplayUpdates(session as never, {
      idleMs: 50,
      pollMs: 20,
      maxMs: 400,
      warmupMs: 200,
    });

    expect(count).toBe(0);
    // warmup + idle, bounded by maxMs — never the full maxMs when idle ends it.
    expect(Date.now() - started).toBeLessThan(500);
  });
});
