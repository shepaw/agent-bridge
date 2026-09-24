import { describe, expect, it } from 'vitest';
import { terminalFramesForTurns } from '../src/peer/peer-connection.js';

describe('terminalFramesForTurns', () => {
  it('replays done and error, and skips a turn that is still streaming', () => {
    const frames = terminalFramesForTurns([
      ['req-done', { status: 'done', done: { content: 'ok', metadata: { source: 'quiet' } } }],
      ['req-err', { status: 'error', error: 'boom' }],
      ['req-live', { status: 'streaming' }],
    ]);
    expect(frames).toEqual([
      { type: 'agent_done', request_id: 'req-done', content: 'ok', metadata: { source: 'quiet' } },
      { type: 'agent_error', request_id: 'req-err', message: 'boom' },
    ]);
  });

  it('omits metadata when the done frame has none', () => {
    const frames = terminalFramesForTurns([
      ['req-done', { status: 'done', done: { content: 'plain' } }],
    ]);
    expect(frames).toEqual([
      { type: 'agent_done', request_id: 'req-done', content: 'plain' },
    ]);
  });
});
