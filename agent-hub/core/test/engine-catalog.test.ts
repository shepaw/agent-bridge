import { describe, expect, it } from 'vitest';

import {
  BUILTIN_ENGINE_BY_ID,
  BUILTIN_ENGINE_CATALOG,
  BUILTIN_ENGINE_IDS,
  acpCommandForEngine,
  isBuiltinEngineId,
} from '../src/engine-catalog.js';

/** Paseo's documented 39 providers (native + ACP catalog). */
const PASEO_PROVIDER_IDS = [
  'claude-code',
  'codex',
  'opencode',
  'pi',
  'copilot',
  'agoragentic',
  'amp',
  'auggie',
  'autohand',
  'cline',
  'codebuddy',
  'codewhale',
  'cortex-code',
  'corust-agent',
  'crow-cli',
  'cursor',
  'deepagents',
  'dimcode',
  'dirac',
  'factory-droid',
  'fast-agent',
  'gemini',
  'glm',
  'goose',
  'grok',
  'hermes',
  'junie',
  'kilo',
  'kimi',
  'minion-code',
  'mistral-vibe',
  'nova',
  'poolside',
  'qoder',
  'qwen-code',
  'sigit',
  'stakpak',
  'traecli',
  'vtcode',
] as const;

describe('builtin engine catalog', () => {
  it('covers Paseo\'s 39 providers plus Shepaw extras', () => {
    expect(PASEO_PROVIDER_IDS).toHaveLength(39);
    for (const id of PASEO_PROVIDER_IDS) {
      expect(isBuiltinEngineId(id), `missing Paseo provider ${id}`).toBe(true);
    }
    expect(BUILTIN_ENGINE_IDS).toEqual(expect.arrayContaining(['openclaw', 'zcode', 'deepseek-harness']));
    expect(BUILTIN_ENGINE_CATALOG).toHaveLength(42);
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
