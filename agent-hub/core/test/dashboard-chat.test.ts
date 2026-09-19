import { describe, expect, it } from 'vitest';

import { createChatStreamAccumulator } from '../src/chat-stream-split.js';
import {
  composeDashboardChatMessage,
  formatDashboardChatAttachments,
  mergeConversationModes,
  normalizeDashboardChatAttachments,
  normalizeDashboardChatMessage,
  parseConversationOption,
  parseConversationOptions,
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

describe('normalizeDashboardChatAttachments', () => {
  it('accepts store:// strings and objects', () => {
    expect(normalizeDashboardChatAttachments([
      'store://agents/0123456789abcdef/chat-uploads/a.txt',
      { uri: 'store://files/0123456789abcdef/notes.md', name: 'notes.md' },
    ])).toEqual([
      { uri: 'store://agents/0123456789abcdef/chat-uploads/a.txt', name: 'a.txt' },
      { uri: 'store://files/0123456789abcdef/notes.md', name: 'notes.md' },
    ]);
  });

  it('rejects non-store uris', () => {
    expect(() => normalizeDashboardChatAttachments(['https://example.com/a'])).toThrow(/store:\/\//);
  });
});

describe('composeDashboardChatMessage', () => {
  it('allows attachment-only turns', () => {
    const out = composeDashboardChatMessage('', [
      { uri: 'store://agents/0123456789abcdef/chat-uploads/shot.png', name: 'shot.png' },
    ]);
    expect(out.text).toContain('shot.png');
    expect(out.text).toContain('store://agents/0123456789abcdef/chat-uploads/shot.png');
    expect(out.attachments).toHaveLength(1);
  });

  it('appends pouch links under the user text', () => {
    const out = composeDashboardChatMessage('please review', [
      'store://workspaces/0123456789abcdef/tmp/spec.md',
    ]);
    expect(out.text.startsWith('please review')).toBe(true);
    expect(out.text).toContain(formatDashboardChatAttachments(out.attachments));
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

describe('conversation model/mode options', () => {
  it('accepts ACP value/display_name and id/name shapes', () => {
    expect(parseConversationOption({ value: 'sonnet', display_name: 'Sonnet', description: 'fast' })).toEqual({
      value: 'sonnet',
      display_name: 'Sonnet',
      description: 'fast',
    });
    expect(parseConversationOption({ id: 'agent', name: 'Agent' })).toEqual({
      value: 'agent',
      display_name: 'Agent',
      description: '',
    });
    expect(parseConversationOption({ name: 'no-id' })).toBeNull();
  });

  it('drops invalid entries from a list', () => {
    expect(parseConversationOptions([
      { value: 'a', display_name: 'A' },
      null,
      'nope',
      { id: 'b', name: 'B', description: 'beta' },
    ])).toEqual([
      { value: 'a', display_name: 'A', description: '' },
      { value: 'b', display_name: 'B', description: 'beta' },
    ]);
  });

  it('falls back to the engine catalog when ACP has no modes yet', () => {
    const fallback = {
      modes: [{ value: 'unrestricted', display_name: 'Unrestricted', description: 'yolo' }],
      current: 'unrestricted',
    };
    expect(mergeConversationModes({ modes: [] }, fallback)).toEqual(fallback);
    expect(mergeConversationModes(
      { modes: [{ value: 'plan', display_name: 'Plan' }] },
      fallback,
    )).toEqual({
      modes: [{ value: 'plan', display_name: 'Plan', description: '' }],
      current: 'unrestricted',
    });
    expect(mergeConversationModes(
      { modes: [{ value: 'plan', display_name: 'Plan' }], current: 'plan' },
      fallback,
    ).current).toBe('plan');
  });
});
