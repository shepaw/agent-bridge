import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { describe, expect, it } from 'vitest';

import { sessionTitle } from '../src/bridge.js';

function userEvent(text: string, seq = 0): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time: 0,
    data: createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }),
  };
}

/** A synthetic `agent.inject()` context message — never a display title. */
function injectedEvent(text: string, seq = 0): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time: 0,
    data: createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'dsh-core', form: 'notice' },
    }),
  };
}

describe('sessionTitle', () => {
  it('returns undefined before the first human prompt', () => {
    expect(sessionTitle([])).toBeUndefined();
    expect(sessionTitle([injectedEvent('subdir AGENTS.md')])).toBeUndefined();
  });

  it('uses the first human prompt, skipping injected context', () => {
    const events = [injectedEvent('injected'), userEvent('first question'), userEvent('second')];
    expect(sessionTitle(events)).toBe('first question');
  });

  it('collapses whitespace and caps the length', () => {
    expect(sessionTitle([userEvent('  a   b\n\nc  ')])).toBe('a b c');
    expect(sessionTitle([userEvent('x'.repeat(200))])).toHaveLength(80);
  });

  it('ignores prompts whose text blocks are all empty', () => {
    const events = [userEvent(''), userEvent('real prompt')];
    expect(sessionTitle(events)).toBe('real prompt');
  });
});
