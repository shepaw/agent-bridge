import { describe, expect, it } from 'vitest';

import {
  classifyInternalPromptKind,
  internalPromptHistoryMetadata,
  isInternalPromptOnly,
  promptToTranscriptUserText,
  sanitizeSessionHistoryMessages,
  stripInternalPromptForTranscript,
} from '../src/internal-prompt-strip.js';
import { buildGroupTaskContextBlock } from '../src/group-context.js';
import { buildStorePouchCard, prependStorePouchCard } from '../src/store-pouch-card.js';
import { promptToPlainText } from '../src/session-transcript-sink.js';

describe('stripInternalPromptForTranscript', () => {
  it('removes a full Scope Card including blank line after header', () => {
    const card = buildStorePouchCard({ deviceId: 'aabbccddeeff0011' });
    expect(isInternalPromptOnly(card)).toBe(true);
    expect(stripInternalPromptForTranscript(card)).toBe('');
  });

  it('keeps user text after Scope Card with paragraph break', () => {
    const card = buildStorePouchCard({ deviceId: 'abc' });
    const bundled = `${card}\n\n帮我排查登录 bug`;
    expect(stripInternalPromptForTranscript(bundled)).toBe('帮我排查登录 bug');
    expect(isInternalPromptOnly(bundled)).toBe(false);
  });

  it('peels user suffix glued to the last Scope Card bullet', () => {
    const card = buildStorePouchCard({ deviceId: 'abc' });
    const glued = card.replace(
      /- 未指定分区时：.*$/,
      '- 未指定分区时：长期文件 → `files`；本轮中间产物 → `runtime`放到储物袋',
    );
    expect(stripInternalPromptForTranscript(glued)).toBe('放到储物袋');
  });

  it('removes Scope Card plus group-task context block', () => {
    const card = buildStorePouchCard({ deviceId: 'abc' });
    const group = buildGroupTaskContextBlock({
      group_id: 'g1',
      group_name: '测试群',
      members: [{ id: 'm1', name: 'Alice', status: 'online' }],
    });
    expect(group).not.toBeNull();
    const bundled = `${card}\n\n${group!}\n\n用户任务`;
    expect(stripInternalPromptForTranscript(bundled)).toBe('用户任务');
  });
});

describe('promptToTranscriptUserText', () => {
  it('does not include Scope Card when blocks are prepended for the engine', () => {
    const card = buildStorePouchCard({ deviceId: 'aabbccddeeff0011' });
    const blocks = prependStorePouchCard([{ type: 'text', text: '放到储物袋' }], card);
    const raw = promptToPlainText(blocks);
    expect(raw).toContain('当前储物袋作用域');
    expect(promptToTranscriptUserText(blocks)).toBe('放到储物袋');
  });
});

describe('classifyInternalPromptKind', () => {
  it('tags stable Scope Card and group context', () => {
    const card = buildStorePouchCard({ deviceId: 'abc' });
    expect(classifyInternalPromptKind(card)).toBe('scope_card_stable');
    const group = buildGroupTaskContextBlock({
      group_id: 'g1',
      group_name: '群',
      members: [{ id: 'm1', name: 'A', status: 'online' }],
    });
    expect(classifyInternalPromptKind(group!)).toBe('group_task_context');
  });
});

describe('sanitizeSessionHistoryMessages', () => {
  it('annotates pure Scope Card rows instead of dropping them', () => {
    const card = buildStorePouchCard({ deviceId: 'abc' });
    const out = sanitizeSessionHistoryMessages([
      { role: 'user', content: card },
      { role: 'agent', content: 'ok' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]?.metadata).toEqual(internalPromptHistoryMetadata(card));
    expect(out[1]?.content).toBe('ok');
  });

  it('strips bundled Scope Card prefix from user turns', () => {
    const card = buildStorePouchCard({ deviceId: 'abc' });
    const out = sanitizeSessionHistoryMessages([
      { role: 'user', content: `${card}\n\n排查 bug` },
    ]);
    expect(out).toEqual([{ role: 'user', content: '排查 bug' }]);
  });
});
