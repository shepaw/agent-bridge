import { describe, expect, it } from 'vitest';

import { createChatStreamAccumulator } from '../src/chat-stream-split.js';
import {
  normalizeDashboardChatMessage,
  parseHistoryMessage,
  resolveDashboardChatSessionId,
} from '../src/instance-acp-rpc.js';

describe('normalizeDashboardChatMessage', () => {
  it('trims a non-empty message', () => {
    expect(normalizeDashboardChatMessage('  hello  ')).toBe('hello');
  });

  it('rejects empty or non-string input', () => {
    expect(() => normalizeDashboardChatMessage('   ')).toThrow(/empty/);
    expect(() => normalizeDashboardChatMessage(1)).toThrow(/string/);
  });
});

describe('resolveDashboardChatSessionId', () => {
  it('keeps a provided session id', () => {
    expect(resolveDashboardChatSessionId('  abc  ')).toBe('abc');
  });

  it('allocates a hub-dash id when omitted', () => {
    const id = resolveDashboardChatSessionId();
    expect(id.startsWith('hub-dash_')).toBe(true);
    expect(id.length).toBeGreaterThan('hub-dash_'.length);
  });
});

describe('createChatStreamAccumulator', () => {
  it('routes collapsible chunks into progress and the rest into the reply', () => {
    const acc = createChatStreamAccumulator();
    acc.onMetadata({ collapsible: true, collapsible_title: 'Thinking', auto_collapse: true });
    acc.onChunk('let me reason');
    acc.onMetadata({ collapsible: false, collapsible_title: '' });
    acc.onChunk('here is the answer');
    expect(acc.result()).toEqual({
      reply: 'here is the answer',
      progressContent: 'let me reason',
      progressTitle: 'Thinking',
      progressAutoCollapse: true,
    });
  });
});

describe('parseHistoryMessage', () => {
  it('keeps thinking progress on agent turns', () => {
    const msg = parseHistoryMessage({
      role: 'agent',
      content: 'done',
      progress_content: 'secret thoughts',
      progress_title: 'Thinking',
      progress_auto_collapse: true,
    });
    expect(msg?.progress_content).toBe('secret thoughts');
    expect(msg?.progress_title).toBe('Thinking');
    expect(msg?.progress_auto_collapse).toBe(true);
  });

  it('keeps a progress-only agent turn', () => {
    const msg = parseHistoryMessage({
      role: 'agent',
      content: '',
      progress_content: 'still thinking',
    });
    expect(msg?.content).toBe('');
    expect(msg?.progress_content).toBe('still thinking');
  });
});
