import { describe, expect, it } from 'vitest';

import { extractEmbeddedTimestamp } from '../src/transcript-timestamp.js';

describe('extractEmbeddedTimestamp', () => {
  it('parses Cursor-style stamps and strips the tag', () => {
    const raw =
      '<timestamp>Sunday, Jul 12, 2026, 7:32 PM (UTC+8)</timestamp>\n<user_query>\nhello\n</user_query>';
    const { text, createdAt } = extractEmbeddedTimestamp(raw);
    expect(text).toBe('<user_query>\nhello\n</user_query>');
    expect(createdAt).toBe(new Date('Sunday, Jul 12, 2026, 7:32 PM (UTC+8)').toISOString());
  });

  it('returns original text when no stamp is present', () => {
    expect(extractEmbeddedTimestamp('plain')).toEqual({ text: 'plain' });
  });

  it('strips an unparsable stamp without inventing createdAt', () => {
    const { text, createdAt } = extractEmbeddedTimestamp('<timestamp>not a date</timestamp>hi');
    expect(text).toBe('hi');
    expect(createdAt).toBeUndefined();
  });
});
