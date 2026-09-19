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

  // Cursor embeds minute precision, so two turns in the same minute arrive with
  // an identical stamp. Clients sort on created_at alone, so a tie lets the
  // second question sort above the first answer.
  it('breaks ties between same-minute turns', () => {
    const sameMinute = '2026-07-12T10:00:00.000Z';
    const input: SessionHistoryMessage[] = [
      { role: 'user', content: 'Q1', created_at: sameMinute },
      { role: 'agent', content: 'A1' },
      { role: 'user', content: 'Q2', created_at: sameMinute },
      { role: 'agent', content: 'A2' },
    ];
    const out = ensureHistoryCreatedAt(input);
    const stamps = out.map((m) => Date.parse(m.created_at!));
    for (let i = 1; i < stamps.length; i++) {
      expect(stamps[i]).toBeGreaterThan(stamps[i - 1]);
    }
    // Transcript order survives a sort on created_at.
    expect([...out].sort((a, b) => a.created_at!.localeCompare(b.created_at!)).map((m) => m.content)).toEqual([
      'Q1',
      'A1',
      'Q2',
      'A2',
    ]);
  });

  it('is idempotent', () => {
    const input: SessionHistoryMessage[] = [
      { role: 'user', content: 'Q1', created_at: '2026-07-12T10:00:00.000Z' },
      { role: 'agent', content: 'A1' },
      { role: 'user', content: 'Q2', created_at: '2026-07-12T10:00:00.000Z' },
    ];
    const once = ensureHistoryCreatedAt(input);
    const twice = ensureHistoryCreatedAt(once);
    expect(twice.map((m) => m.created_at)).toEqual(once.map((m) => m.created_at));
  });
});
