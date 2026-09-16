import { describe, expect, it } from 'vitest';

import {
  stripCopySessionInfoHeader,
  stripSessionInfoFromPrompt,
} from '../src/strip-session-info-header.js';

describe('stripCopySessionInfoHeader', () => {
  it('removes zh copy-session-info prefix', () => {
    const raw =
      '标题：你当前处于一个群聊环境中。\n' +
      '会话 ID：gmd_group_abc__agent1\n' +
      'channel ID：group_abc\n\n' +
      '【你的任务】摸底链路';
    expect(stripCopySessionInfoHeader(raw)).toBe('【你的任务】摸底链路');
  });

  it('removes en copy-session-info prefix', () => {
    const raw =
      'Title: Group chat\n' +
      'Session ID: sess_1\n' +
      'channel ID: group_x\n\n' +
      'Task body';
    expect(stripCopySessionInfoHeader(raw)).toBe('Task body');
  });

  it('leaves normal text unchanged', () => {
    const raw = '【你的任务】只做三件事';
    expect(stripCopySessionInfoHeader(raw)).toBe(raw);
  });
});

describe('stripSessionInfoFromPrompt', () => {
  it('strips first text block in array', () => {
    const blocks = [
      {
        type: 'text' as const,
        text:
          '标题：foo\n会话 ID：bar\nchannel ID：baz\n\nreal task',
      },
    ];
    const out = stripSessionInfoFromPrompt(blocks);
    expect(Array.isArray(out)).toBe(true);
    expect((out as typeof blocks)[0].text).toBe('real task');
  });
});
