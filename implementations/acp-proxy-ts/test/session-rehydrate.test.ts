import { describe, expect, it } from 'vitest';

import { formatHistoryPreamble, prependHistoryToPrompt } from '../src/session-rehydrate.js';

describe('session rehydrate', () => {
  it('formats prior turns and skips empty/system roles', () => {
    const text = formatHistoryPreamble([
      { role: 'system', content: 'ignore me' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: '   ' },
    ]);
    expect(text).toContain('User: hello');
    expect(text).toContain('Assistant: hi');
    expect(text).not.toContain('ignore me');
    expect(text).toContain('Current user message follows.');
  });

  it('prepends a text block ahead of the current prompt', () => {
    const blocks = prependHistoryToPrompt('what next?', [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual(
      expect.objectContaining({ type: 'text', text: expect.stringContaining('User: hello') }),
    );
    expect(blocks[1]).toEqual({ type: 'text', text: 'what next?' });
  });

  it('leaves the prompt unchanged when history has no usable turns', () => {
    expect(prependHistoryToPrompt('go', [{ role: 'system', content: 'x' }])).toEqual([
      { type: 'text', text: 'go' },
    ]);
  });
});
