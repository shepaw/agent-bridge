import { describe, expect, it } from 'vitest';

import { ensureHistoryCreatedAt } from '../src/history-created-at.js';
import type { SessionHistoryMessage } from 'shepaw-acp-sdk';

describe('ensureHistoryCreatedAt', () => {
  it('keeps existing stamps and forward-fills gaps', () => {
    const input: SessionHistoryMessage[] = [
      { role: 'user', content: 'a', created_at: '2026-07-12T10:00:00.000Z' },
      { role: 'agent', content: 'b' },
      { role: 'user', content: 'c', created_at: '2026-07-12T10:05:00.000Z' },
      { role: 'agent', content: 'd' },
    ];
    const out = ensureHistoryCreatedAt(input);
    expect(out[0].created_at).toBe('2026-07-12T10:00:00.000Z');
    expect(out[1].created_at).toBe('2026-07-12T10:00:01.000Z');
    expect(out[2].created_at).toBe('2026-07-12T10:05:00.000Z');
    expect(out[3].created_at).toBe('2026-07-12T10:05:01.000Z');
  });

  it('anchors fully unstamped transcripts to sessionUpdatedAt', () => {
    const input: SessionHistoryMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'agent', content: 'b' },
      { role: 'user', content: 'c' },
    ];
    const out = ensureHistoryCreatedAt(input, {
      sessionUpdatedAt: '2026-07-12T12:00:00.000Z',
    });
    expect(out.map((m) => m.created_at)).toEqual([
      '2026-07-12T11:58:00.000Z',
      '2026-07-12T11:59:00.000Z',
      '2026-07-12T12:00:00.000Z',
    ]);
  });

  it('always returns created_at on every message', () => {
    const out = ensureHistoryCreatedAt([{ role: 'user', content: 'only' }]);
    expect(out[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
