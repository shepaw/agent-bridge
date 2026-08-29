import { describe, expect, it } from 'vitest';

import {
  extractResumeSummary,
  replaceResumeSummarySection,
  renderSummaryOnlyResumeMd,
} from '../src/workspace-resume.js';

describe('replaceResumeSummarySection', () => {
  it('replaces Summary and keeps every other section verbatim', () => {
    const md = [
      '# a — Agent Resume',
      '',
      '## Workspace',
      '- path: `/x`',
      '',
      '## Summary',
      'old',
      '',
      '## 自我补充 / Self Notes',
      '<!-- SHEPAW_RESUME_NOTES_START -->',
      'notes',
      '<!-- SHEPAW_RESUME_NOTES_END -->',
    ].join('\n');
    const out = replaceResumeSummarySection(md, 'new');
    expect(extractResumeSummary(out)).toBe('new');
    expect(out).toContain('- path: `/x`');
    expect(out).toContain('notes');
    expect(out).not.toContain('old');
  });

  it('appends a Summary before the Self Notes heading when missing', () => {
    const md = [
      '# a — Agent Resume',
      '',
      '## 自我补充 / Self Notes',
      '<!-- SHEPAW_RESUME_NOTES_START -->',
      'notes',
      '<!-- SHEPAW_RESUME_NOTES_END -->',
    ].join('\n');
    const out = replaceResumeSummarySection(md, 'fresh');
    const summaryIdx = out.indexOf('## Summary');
    const notesIdx = out.indexOf('## 自我补充 / Self Notes');
    expect(summaryIdx).toBeGreaterThan(0);
    expect(notesIdx).toBeGreaterThan(0);
    // Summary must precede the Self Notes heading.
    expect(summaryIdx).toBeLessThan(notesIdx);
    // Body of the appended section must sit between its heading and the
    // notes heading (splitMarkdownSections is first-occurrence-wins).
    const body = out.slice(out.indexOf('## Summary'), notesIdx);
    expect(body).toContain('fresh');
    expect(out).toContain('notes');
  });

  it('appends Summary at the end when no markers exist', () => {
    const out = replaceResumeSummarySection('# a', 'only');
    expect(extractResumeSummary(out)).toBe('only');
  });

  it('round-trips with renderSummaryOnlyResumeMd', () => {
    const seeded = renderSummaryOnlyResumeMd('agent-1', 'v1');
    const updated = replaceResumeSummarySection(seeded, 'v2');
    expect(extractResumeSummary(updated)).toBe('v2');
    expect(updated).toContain('## 自我补充 / Self Notes');
  });
});
