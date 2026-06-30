import { describe, expect, it } from 'vitest';

import { deriveBusyLevel } from '../src/types.js';

describe('deriveBusyLevel', () => {
  it('maps task counts to busy levels', () => {
    expect(deriveBusyLevel(0)).toBe('idle');
    expect(deriveBusyLevel(1)).toBe('busy');
    expect(deriveBusyLevel(2)).toBe('busy');
    expect(deriveBusyLevel(3)).toBe('overloaded');
  });
});
