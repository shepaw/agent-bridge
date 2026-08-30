import { describe, expect, it } from 'vitest';

import {
  RESUME_PROMPT_MAX_LENGTH,
  aiSummaryMarker,
  composeAgentResume,
  normalizeResumePrompt,
  preserveAiSummary,
  renderCustomPromptSection,
  renderResumeMarkdown,
  renderSummaryOnlyResumeMd,
  replaceResumeSummarySection,
  resolveResumePrompt,
  resumePromptFingerprint,
  type AgentResumeInput,
  type WorkspaceProfile,
} from '../src/workspace-resume.js';

const INPUT: AgentResumeInput = {
  agentId: 'acp_agent_deadbeef',
  fingerprint: 'cafe000000000000',
  engineId: 'claude-code',
  engineDisplayName: 'Claude Code',
  agentName: 'Prompt Demo',
  cwd: '/tmp/prompt-demo',
};

function fakeProfile(overrides: Partial<WorkspaceProfile> = {}): WorkspaceProfile {
  return {
    projectName: 'prompt-demo',
    projectDescription: 'A demo project',
    language: 'TypeScript',
    languages: ['TypeScript'],
    frameworks: [],
    packageManager: 'npm',
    scripts: { build: true, test: true, lint: false, dev: false, format: false, deploy: false },
    makefileTargets: [],
    hasTests: true,
    sources: ['package.json'],
    ...overrides,
  };
}

describe('normalizeResumePrompt', () => {
  it('returns undefined for empty / whitespace / non-string input', () => {
    expect(normalizeResumePrompt(undefined)).toBeUndefined();
    expect(normalizeResumePrompt(null)).toBeUndefined();
    expect(normalizeResumePrompt('')).toBeUndefined();
    expect(normalizeResumePrompt('   \n\t ')).toBeUndefined();
    expect(normalizeResumePrompt(42)).toBeUndefined();
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeResumePrompt('  突出测试能力 \n')).toBe('突出测试能力');
  });

  it('caps at the shared max length', () => {
    expect(normalizeResumePrompt('x'.repeat(RESUME_PROMPT_MAX_LENGTH + 500))).toHaveLength(
      RESUME_PROMPT_MAX_LENGTH,
    );
  });
});

describe('resumePromptFingerprint / aiSummaryMarker', () => {
  it('is stable and 8 hex chars', () => {
    expect(resumePromptFingerprint('abc')).toMatch(/^[0-9a-f]{8}$/);
    expect(resumePromptFingerprint('abc')).toBe(resumePromptFingerprint('abc'));
    expect(resumePromptFingerprint('abc')).not.toBe(resumePromptFingerprint('abd'));
  });

  it('embeds the hash in the marker', () => {
    expect(aiSummaryMarker('0123abcd')).toBe('<!-- SHEPAW_RESUME_AI:0123abcd -->');
  });
});

describe('renderCustomPromptSection', () => {
  it('renders the prompt verbatim under the custom heading with the marker', () => {
    const lines = renderCustomPromptSection('语气务实，突出测试。');
    const section = lines.join('\n');
    expect(section).toContain('## 自定义要求 / Custom Instructions');
    expect(section).toContain('语气务实，突出测试。');
    expect(section).toContain(aiSummaryMarker(resumePromptFingerprint('语气务实，突出测试。')));
  });
});

describe('renderResumeMarkdown with prompt', () => {
  const profile = fakeProfile();

  it('omits the custom section entirely when no prompt is set (byte-identical legacy output)', () => {
    const md = renderResumeMarkdown(INPUT, profile, composeAgentResume(INPUT, profile, '0.0.0'));
    expect(md).not.toContain('自定义要求');
    expect(md).not.toContain('SHEPAW_RESUME_AI');
  });

  it('inserts the custom section between Capabilities and Summary', () => {
    const input: AgentResumeInput = { ...INPUT, resumePrompt: '突出测试与构建。' };
    const md = renderResumeMarkdown(input, profile, composeAgentResume(input, profile, '0.0.0'));
    const capAt = md.indexOf('## Capabilities');
    const customAt = md.indexOf('## 自定义要求 / Custom Instructions');
    const summaryAt = md.indexOf('## Summary');
    expect(capAt).toBeGreaterThanOrEqual(0);
    expect(customAt).toBeGreaterThan(capAt);
    expect(summaryAt).toBeGreaterThan(customAt);
    expect(md).toContain('突出测试与构建。');
    // Self Notes survive untouched.
    expect(md).toContain('自我补充 / Self Notes');
  });
});

describe('preserveAiSummary', () => {
  const promptSha = resumePromptFingerprint('same prompt');
  const aiSummary = `${aiSummaryMarker(promptSha)}\nAI 写的简历。`;

  it('keeps the AI-authored summary when the prompt hash matches', () => {
    const doc = renderSummaryOnlyResumeMd('Prompt Demo', aiSummary);
    expect(preserveAiSummary(doc, '确定性模板文本', promptSha)).toContain('AI 写的简历');
    expect(preserveAiSummary(doc, '确定性模板文本', promptSha)).not.toBe('确定性模板文本');
  });

  it('falls back to the fresh summary when the prompt changed', () => {
    const doc = renderSummaryOnlyResumeMd('Prompt Demo', aiSummary);
    const otherSha = resumePromptFingerprint('a different prompt');
    expect(preserveAiSummary(doc, '确定性模板文本', otherSha)).toBe('确定性模板文本');
  });

  it('falls back when there is no AI marker or no Summary at all', () => {
    const plain = renderSummaryOnlyResumeMd('Prompt Demo', '普通手写 Summary');
    expect(preserveAiSummary(plain, 'fresh', promptSha)).toBe('fresh');
    expect(preserveAiSummary('', 'fresh', promptSha)).toBe('fresh');
  });

  it('survives a markdown round-trip through replaceResumeSummarySection', () => {
    const doc = renderSummaryOnlyResumeMd('Prompt Demo', aiSummary);
    const rewritten = replaceResumeSummarySection(doc, `${aiSummaryMarker(promptSha)}\nAI 第二版。`);
    expect(preserveAiSummary(rewritten, 'fresh', promptSha)).toContain('AI 第二版');
  });
});

describe('resolveResumePrompt (env fallback)', () => {
  it('reads SHEPAW_RESUME_PROMPT and treats blank as absent', () => {
    expect(resolveResumePrompt({ SHEPAW_RESUME_PROMPT: '  自定义  ' })).toBe('自定义');
    expect(resolveResumePrompt({})).toBeUndefined();
    expect(resolveResumePrompt({ SHEPAW_RESUME_PROMPT: '   ' })).toBeUndefined();
  });
});
