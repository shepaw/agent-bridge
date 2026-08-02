import { describe, expect, it } from 'vitest';

import { filterListedSessions, shouldExposeListedSession } from '../src/sessions-filter.js';

const ctx = (overrides: Partial<{
  disposable: string[];
  orphaned: string[];
  preserve: string[];
  active: string[];
}> = {}) => ({
  disposableUpstreamIds: new Set(overrides.disposable ?? []),
  orphanedUpstreamIds: new Set(overrides.orphaned ?? []),
  preserveUpstreamIds: new Set(overrides.preserve ?? []),
  activeUpstreamIds: new Set(overrides.active ?? []),
});

describe('shouldExposeListedSession', () => {
  it('drops disposable warmup sessions', () => {
    expect(
      shouldExposeListedSession(
        { sessionId: 'warm-1', cwd: '/tmp' },
        ctx({ disposable: ['warm-1'] }),
      ),
    ).toBe(false);
  });

  it('drops orphaned fork sessions even when titled', () => {
    // Regression: a conversation that forked to a new upstream session left the
    // old one agent-side; sync adopted it as a duplicate app session.
    expect(
      shouldExposeListedSession(
        { sessionId: 'fork-old', cwd: '/tmp', title: 'Earlier half of chat' },
        ctx({ orphaned: ['fork-old'] }),
      ),
    ).toBe(false);
  });

  it('keeps titled sessions', () => {
    expect(
      shouldExposeListedSession(
        { sessionId: 'real-1', cwd: '/tmp', title: 'Fix login bug' },
        ctx(),
      ),
    ).toBe(true);
  });

  it('keeps untitled sessions that are mapped or active', () => {
    expect(
      shouldExposeListedSession(
        { sessionId: 'mapped', cwd: '/tmp' },
        ctx({ preserve: ['mapped'] }),
      ),
    ).toBe(true);
    expect(
      shouldExposeListedSession(
        { sessionId: 'live', cwd: '/tmp' },
        ctx({ active: ['live'] }),
      ),
    ).toBe(true);
  });

  it('drops untitled unmapped ghost sessions', () => {
    expect(
      shouldExposeListedSession(
        { sessionId: 'ghost', cwd: '/tmp', title: null },
        ctx(),
      ),
    ).toBe(false);
    expect(
      shouldExposeListedSession(
        { sessionId: 'ghost2', cwd: '/tmp', title: '   ' },
        ctx(),
      ),
    ).toBe(false);
  });
});

describe('filterListedSessions', () => {
  it('filters a mixed list', () => {
    const out = filterListedSessions(
      [
        { sessionId: 'warm', cwd: '/tmp' },
        { sessionId: 'titled', cwd: '/tmp', title: 'Hello' },
        { sessionId: 'ghost', cwd: '/tmp' },
      ],
      ctx({ disposable: ['warm'] }),
    );
    expect(out.map((s) => s.sessionId)).toEqual(['titled']);
  });
});
