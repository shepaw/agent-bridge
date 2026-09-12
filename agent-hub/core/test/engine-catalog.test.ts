import { describe, expect, it } from 'vitest';

import {
  BUILTIN_ENGINE_BY_ID,
  BUILTIN_ENGINE_CATALOG,
  BUILTIN_ENGINE_IDS,
  acpCommandForEngine,
  isBuiltinEngineId,
} from '../src/engine-catalog.js';

describe('builtin engine catalog', () => {
  it('registers the well-known ACP engines', () => {
    for (const id of [
      'claude-code',
      'tclaude',
      'claude-internal',
      'codex',
      'tcodex',
      'copilot',
      'gemini',
      'gemini-internal',
      'kiro',
      'knot',
      'qwen-code',
      'opencode',
      'cursor',
      'pi',
      'openclaw',
      'zcode',
      'deepseek-harness',
    ]) {
      expect(isBuiltinEngineId(id), `missing engine ${id}`).toBe(true);
    }
    expect(BUILTIN_ENGINE_CATALOG.length).toBe(BUILTIN_ENGINE_IDS.length);
    expect(BUILTIN_ENGINE_CATALOG.length).toBeGreaterThan(10);
  });

  it('has unique ids and a complete lookup table', () => {
    const ids = BUILTIN_ENGINE_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(BUILTIN_ENGINE_IDS).toEqual(ids);
    for (const id of ids) {
      expect(BUILTIN_ENGINE_BY_ID[id]?.id).toBe(id);
      expect(acpCommandForEngine(id).length).toBeGreaterThan(0);
    }
  });

  it('records spawn commands for popular ACP CLIs', () => {
    expect(acpCommandForEngine('pi')).toBe('npx -y pi-acp');
    expect(acpCommandForEngine('codebuddy')).toBe('codebuddy --acp');
    expect(acpCommandForEngine('zcode')).toBe('npx -y zcode-acp-server@latest');
    expect(acpCommandForEngine('copilot')).toBe('copilot --acp');
    expect(acpCommandForEngine('gemini')).toBe('gemini --acp');
    expect(acpCommandForEngine('kiro')).toBe('kiro-cli acp --trust-all-tools');
    expect(acpCommandForEngine('knot')).toBe('knot-cli acp');
    expect(acpCommandForEngine('qwen-code')).toBe('qwen --acp');
    expect(acpCommandForEngine('tclaude')).toBe('npx -y @agentclientprotocol/claude-agent-acp@latest');
    expect(acpCommandForEngine('tcodex')).toBe('npx -y @agentclientprotocol/codex-acp@latest');
  });
});
