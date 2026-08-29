import { describe, expect, it } from 'vitest';

import { mentionsResume } from '../src/agent.js';

describe('mentionsResume', () => {
  it('fires on explicit resume mentions', () => {
    expect(mentionsResume('帮我改一下你的简历')).toBe(true);
    expect(mentionsResume('请更新 resume.md 里的 Summary')).toBe(true);
    expect(mentionsResume('update your résumé please')).toBe(true);
  });

  it('does not fire on normal chats', () => {
    expect(mentionsResume('跑一下测试然后修 lint')).toBe(false);
    expect(mentionsResume('这个 bug 怎么修？')).toBe(false);
    expect(mentionsResume('resume work on the feature branch')).toBe(false);
  });

  it('skips oversized messages without scanning', () => {
    const big = `${'x'.repeat(2000)}简历`;
    expect(mentionsResume(big)).toBe(false);
  });
});
