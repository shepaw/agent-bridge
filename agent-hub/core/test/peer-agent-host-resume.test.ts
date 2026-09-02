/**
 * Unit tests for the resume.md → advertised-bio helper in peer-agent-host.ts.
 *
 * parseResumeSummary must pull exactly the `## Summary` section body so the
 * hub can advertise a managed instance's real workspace resume to paired Shepaw
 * apps (instead of the engine label).
 */

import { describe, expect, it } from 'vitest';
import { parseResumeSummary } from '../src/peer/peer-agent-host.js';

describe('parseResumeSummary', () => {
  it('extracts the Summary body up to the next heading', () => {
    const md = [
      '# shepaw — Agent Resume',
      '',
      '## Summary',
      '我负责 ShePaw 客户端的功能开发与维护。',
      '可独立完成：跑测试、修失败用例、保持构建通过。',
      '',
      '## 自我补充 / Self Notes',
      '<!-- note -->',
    ].join('\n');
    expect(parseResumeSummary(md)).toBe(
      '我负责 ShePaw 客户端的功能开发与维护。\n可独立完成：跑测试、修失败用例、保持构建通过。',
    );
  });

  it('handles Summary as the final section (no trailing heading)', () => {
    const md = '## Summary\n第一行。\n第二行。';
    expect(parseResumeSummary(md)).toBe('第一行。\n第二行。');
  });

  it('handles CRLF line endings', () => {
    const md = '## Summary\r\n负责跑测试。\r\n\r\n## Notes\r\nx';
    expect(parseResumeSummary(md)).toBe('负责跑测试。');
  });

  it('returns empty string when there is no ## Summary section', () => {
    expect(parseResumeSummary('# just a title')).toBe('');
    expect(parseResumeSummary('## 自我补充\n正文')).toBe('');
    expect(parseResumeSummary('')).toBe('');
  });

  it('returns empty string for whitespace-only Summary body', () => {
    expect(parseResumeSummary('## Summary\n\n   \n')).toBe('');
  });

  it('does not treat a Summary mention inside body text as a heading', () => {
    const md = '## Summary\n正文提到 ## Summary 不算。\n## 下一节\n内容';
    expect(parseResumeSummary(md)).toBe('正文提到 ## Summary 不算。');
  });
});
