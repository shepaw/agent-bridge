import { describe, expect, it } from 'vitest';

import {
  CURSOR_STALE_AUTH_MESSAGE,
  isPossibleStaleAuthPrefix,
  isStaleAuthMessage,
} from '../src/stale-auth.js';

describe('isStaleAuthMessage', () => {
  it('matches the canonical Cursor reply', () => {
    expect(isStaleAuthMessage(CURSOR_STALE_AUTH_MESSAGE)).toBe(true);
    expect(isStaleAuthMessage('  Please sign in to continue  ')).toBe(true);
    expect(isStaleAuthMessage('Please sign in to continue.')).toBe(true);
  });

  it('rejects normal assistant text', () => {
    expect(isStaleAuthMessage('Hello')).toBe(false);
    expect(isStaleAuthMessage('Please sign in to continue and then run tests')).toBe(false);
    expect(isStaleAuthMessage('')).toBe(false);
  });
});

describe('isPossibleStaleAuthPrefix', () => {
  it('holds empty and growing prefixes of the error', () => {
    expect(isPossibleStaleAuthPrefix('')).toBe(true);
    expect(isPossibleStaleAuthPrefix('Please')).toBe(true);
    expect(isPossibleStaleAuthPrefix('Please sign in to continue')).toBe(true);
  });

  it('releases once the buffer diverges', () => {
    expect(isPossibleStaleAuthPrefix('Hello')).toBe(false);
    expect(isPossibleStaleAuthPrefix('Please note')).toBe(false);
  });
});
