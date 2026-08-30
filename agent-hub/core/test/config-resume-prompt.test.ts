/**
 * Coverage for the per-instance resumePrompt config field: normalization on
 * add/update, persistence round-trip, plaintext storage, and the spawn-time
 * SHEPAW_RESUME_PROMPT env injection.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  RESUME_PROMPT_MAX_LENGTH,
  addInstance,
  loadOrCreateHubConfig,
  normalizeResumePromptConfig,
  updateInstance,
} from '../src/config.js';
import { buildResumePolishMessage, extractPolishedSummary } from '../src/instance-acp-rpc.js';

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'shepaw-hub-resume-test-'));
  prevHome = process.env.SHEPAW_HUB_HOME;
  process.env.SHEPAW_HUB_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.SHEPAW_HUB_HOME;
  else process.env.SHEPAW_HUB_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

let nextPort = 19500;

function addTestInstance(id: string, resumePrompt?: string): void {
  let cfg = loadOrCreateHubConfig();
  cfg = addInstance(cfg, {
    id,
    label: id,
    engine: 'claude-code',
    cwd: home,
    host: '127.0.0.1',
    port: nextPort++,
    baseUrl: '',
    extraArgs: [],
    createdAt: new Date().toISOString(),
    ...(resumePrompt !== undefined ? { resumePrompt } : {}),
  });
}

function savedPrompt(id: string): string | undefined {
  return loadOrCreateHubConfig().instances.find((p) => p.id === id)?.resumePrompt;
}

describe('normalizeResumePromptConfig', () => {
  it('drops empty / whitespace values, rejects non-strings', () => {
    expect(normalizeResumePromptConfig('')).toEqual({});
    expect(normalizeResumePromptConfig('   \n ')).toEqual({});
    expect(normalizeResumePromptConfig(undefined)).toEqual({});
    expect(() => normalizeResumePromptConfig(42)).toThrow(/must be a string/);
  });

  it('trims valid strings', () => {
    expect(normalizeResumePromptConfig('  突出测试 \n')).toEqual({ resumePrompt: '突出测试' });
  });

  it('rejects over-length prompts instead of truncating silently', () => {
    expect(() => normalizeResumePromptConfig('x'.repeat(RESUME_PROMPT_MAX_LENGTH + 1))).toThrow(/too long/);
  });
});

describe('instance resumePrompt persistence', () => {
  it('persists on add and survives a config reload round-trip', () => {
    addTestInstance('r1', '语气务实，突出测试能力。');
    expect(savedPrompt('r1')).toBe('语气务实，突出测试能力。');
  });

  it('stores the prompt in plaintext (instruction, not a credential)', () => {
    addTestInstance('r2', 'PLAINTEXT_PROMPT_MARKER');
    const raw = readFileSync(join(home, 'hub.json'), 'utf-8');
    expect(raw).toContain('PLAINTEXT_PROMPT_MARKER');
  });

  it('updateInstance sets, overwrites, and clears (empty string removes the key)', () => {
    addTestInstance('r3');
    expect(savedPrompt('r3')).toBeUndefined();

    let cfg = loadOrCreateHubConfig();
    cfg = updateInstance(cfg, 'r3', { resumePrompt: '第一版' });
    expect(savedPrompt('r3')).toBe('第一版');

    cfg = updateInstance(cfg, 'r3', { resumePrompt: '第二版' });
    expect(savedPrompt('r3')).toBe('第二版');

    cfg = updateInstance(cfg, 'r3', { resumePrompt: '' });
    const reloaded = loadOrCreateHubConfig().instances.find((p) => p.id === 'r3');
    expect(reloaded?.resumePrompt).toBeUndefined();
    expect(JSON.stringify(reloaded)).not.toContain('resumePrompt');
  });

  it('rejects over-length prompts on update without touching the saved value', () => {
    addTestInstance('r4', '原始提示词');
    let cfg = loadOrCreateHubConfig();
    expect(() => updateInstance(cfg, 'r4', { resumePrompt: 'x'.repeat(RESUME_PROMPT_MAX_LENGTH + 1) })).toThrow();
    cfg = loadOrCreateHubConfig();
    expect(cfg.instances.find((p) => p.id === 'r4')?.resumePrompt).toBe('原始提示词');
  });
});

describe('buildResumePolishMessage', () => {
  it('interpolates agent id, cwd, label and the verbatim prompt as a draft-only turn', () => {
    const msg = buildResumePolishMessage({
      agentId: 'acp_agent_x',
      prompt: '简洁中文，突出构建。',
      cwd: '/work/demo',
      label: '演示实例',
    });
    // Draft-only: no shim commands, no writes — the hub applies the text via
    // agent.resume.summarySet so no tool call (or approval) happens.
    expect(msg).not.toContain('agents.resume-get');
    expect(msg).not.toContain('agents.resume-set');
    expect(msg).toContain('<<<RESUME_SUMMARY_BEGIN>>>');
    expect(msg).toContain('<<<RESUME_SUMMARY_END>>>');
    expect(msg).toContain('不要运行任何命令');
    expect(msg).toContain('/work/demo');
    expect(msg).toContain('演示实例');
    expect(msg).toContain('【自定义提示词】\n简洁中文，突出构建。');
  });

  it('extractPolishedSummary pulls the text between the markers and trims it', () => {
    const reply = [
      '好的，以下是我重写的 Summary：',
      '<<<RESUME_SUMMARY_BEGIN>>>',
      '  负责构建流水线与测试修复。  ',
      '<<<RESUME_SUMMARY_END>>>',
      '已按要求输出。',
    ].join('\n');
    expect(extractPolishedSummary(reply)).toBe('负责构建流水线与测试修复。');
  });

  it('extractPolishedSummary returns null when markers are missing or inverted', () => {
    expect(extractPolishedSummary('no markers here')).toBeNull();
    expect(extractPolishedSummary('<<<RESUME_SUMMARY_END>>>before<<<RESUME_SUMMARY_BEGIN>>>')).toBeNull();
    expect(extractPolishedSummary('<<<RESUME_SUMMARY_BEGIN>>>\n<<<RESUME_SUMMARY_END>>>')).toBeNull();
  });

  it('falls back to the agent id when no label is given', () => {
    const msg = buildResumePolishMessage({ agentId: 'a1', prompt: 'p', cwd: '/c' });
    expect(msg).toContain('a1」');
  });
});
