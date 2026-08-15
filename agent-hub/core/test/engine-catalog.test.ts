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
      'codex',
      'opencode',
      'cursor',
      'gemini',
      'copilot',
      'pi',
      'qwen-code',
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
    expect(acpCommandForEngine('gemini')).toBe('npx -y @google/gemini-cli@latest --acp');
    expect(acpCommandForEngine('copilot')).toBe('copilot --acp');
    expect(acpCommandForEngine('pi')).toBe('npx -y pi-acp');
    expect(acpCommandForEngine('qwen-code')).toBe('qwen --acp');
    expect(BUILTIN_ENGINE_BY_ID.auggie.spawnEnv?.AUGMENT_DISABLE_AUTO_UPDATE).toBe('1');
    expect(BUILTIN_ENGINE_BY_ID.vtcode.spawnEnv?.VT_ACP_ENABLED).toBe('1');
  });
});
