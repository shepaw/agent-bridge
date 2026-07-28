import { describe, expect, it } from 'vitest';

import { isAcpAgentExitedError } from '../src/acp-subprocess.js';

describe('isAcpAgentExitedError', () => {
  it('matches upstream exit messages (incl. SIGTERM 143)', () => {
    expect(
      isAcpAgentExitedError(
        new Error('ACP agent exited (143) — upstream agent process was terminated'),
      ),
    ).toBe(true);
    expect(isAcpAgentExitedError(new Error('ACP agent exited (SIGTERM)'))).toBe(true);
    expect(
      isAcpAgentExitedError(
        new Error('ACP agent exited (1) — check CURSOR_API_KEY or run cursor-agent login'),
      ),
    ).toBe(true);
  });

  it('rejects unrelated errors', () => {
    expect(isAcpAgentExitedError(new Error('ACP connection not established'))).toBe(false);
    expect(isAcpAgentExitedError(new Error('Please sign in to continue'))).toBe(false);
    expect(isAcpAgentExitedError('not an error object')).toBe(false);
  });
});
