import { describe, expect, it } from 'vitest';

import { extractDashboardUrl, shouldCountAsCrash } from '../src/web-supervisor.js';

describe('extractDashboardUrl', () => {
  it('finds the ready line in accumulated output', () => {
    expect(
      extractDashboardUrl('Starting dashboard on http://127.0.0.1:4100 ...\nDashboard ready: http://127.0.0.1:4100\n'),
    ).toBe('http://127.0.0.1:4100');
  });

  it('matches when the ready line is split across chunks', () => {
    expect(extractDashboardUrl('Dashboard read')).toBeUndefined();
    // URL cut mid-way, no newline yet — must NOT match (would open a bad URL)
    expect(extractDashboardUrl('Dashboard ready: http://127.0.0.1:41')).toBeUndefined();
    expect(extractDashboardUrl('Dashboard ready: http://127.0.0.1:4100\n')).toBe(
      'http://127.0.0.1:4100',
    );
    // Second chunk completes the line from an earlier partial buffer
    expect(extractDashboardUrl('Dashboard ready: http://127.0.0.1:4100\nPeer: ok\n')).toBe(
      'http://127.0.0.1:4100',
    );
  });

  it('returns undefined before the server is ready', () => {
    expect(extractDashboardUrl('Starting Shepaw Hub dashboard...')).toBeUndefined();
  });
});

describe('shouldCountAsCrash', () => {
  it('never counts an intentional restart (exit code 0)', () => {
    expect(shouldCountAsCrash(0, null, 10)).toBe(false);
    expect(shouldCountAsCrash(0, null, 0)).toBe(false);
  });

  it('counts fast non-zero exits as crashes', () => {
    expect(shouldCountAsCrash(1, null, 100)).toBe(true);
    expect(shouldCountAsCrash(null, 'SIGKILL', 2500)).toBe(true);
  });

  it('does not count exits after the stop window', () => {
    expect(shouldCountAsCrash(1, null, 10_000)).toBe(false);
  });
});
