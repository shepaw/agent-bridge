import { describe, expect, it } from 'vitest';

import { stripInternalPromptForTranscript } from '../src/internal-prompt-strip.js';
import { promptToPlainText } from '../src/session-transcript-sink.js';
import { buildStorePouchCard, prependStorePouchCard } from '../src/store-pouch-card.js';

describe('transcript user text', () => {
  it('does not include Scope Card when blocks are prepended for the engine', () => {
    const card = buildStorePouchCard({ deviceId: 'aabbccddeeff0011' });
    const blocks = prependStorePouchCard(
      [{ type: 'text', text: '放到储物袋' }],
      card,
    );
    const raw = promptToPlainText(blocks);
    const forTranscript = stripInternalPromptForTranscript(raw);
    expect(raw).toContain('当前储物袋作用域');
    expect(forTranscript).toBe('放到储物袋');
  });
});
