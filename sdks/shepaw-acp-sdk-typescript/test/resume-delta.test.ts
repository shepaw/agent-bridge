import { describe, expect, it } from 'vitest';

import { resumeDeltaBase } from '../src/resume-delta.js';

describe('resumeDeltaBase', () => {
  it('clamps the cursor into the buffer', () => {
    expect(resumeDeltaBase('hello', 0)).toBe(0);
    expect(resumeDeltaBase('hello', 3)).toBe(3);
    expect(resumeDeltaBase('hello', 99)).toBe(5);
    expect(resumeDeltaBase('hello', -3)).toBe(0);
  });

  it('backs up instead of splitting a surrogate pair', () => {
    // 'a' + 😀 (2 code units) + 'b'
    const text = 'a\u{1F600}b';
    expect(text.length).toBe(4);

    // Cursor lands between the high and low surrogate — slicing here would
    // start the delta with an orphaned low surrogate.
    const base = resumeDeltaBase(text, 2);
    expect(base).toBe(1);
    expect(text.slice(base)).toBe('\u{1F600}b');
  });

  it('leaves an aligned cursor untouched', () => {
    const text = 'a\u{1F600}b';
    expect(resumeDeltaBase(text, 1)).toBe(1);
    expect(resumeDeltaBase(text, 3)).toBe(3);
    expect(resumeDeltaBase(text, 4)).toBe(4);
  });
});
