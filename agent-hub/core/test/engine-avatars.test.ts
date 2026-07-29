import { describe, expect, it } from 'vitest';

import {
  GENERIC_DEFAULT_AVATAR,
  defaultAvatarForEngine,
  engineAvatarMarker,
  listBundledEngineAvatarIds,
  loadEngineAvatarPayload,
  resolveEngineAvatarFile,
} from '../src/engine-avatars.js';
import { BUILTIN_ENGINE_IDS } from '../src/engines.js';

describe('engine avatars (hub-owned assets)', () => {
  it('resolves on-disk files for builtin engines that ship logos', () => {
    const bundled = new Set(listBundledEngineAvatarIds());
    expect(bundled.has('cursor')).toBe(true);
    expect(bundled.has('claude-code')).toBe(true);
    for (const id of BUILTIN_ENGINE_IDS) {
      if (!bundled.has(id)) continue;
      expect(resolveEngineAvatarFile(id)).toBeTruthy();
      const payload = loadEngineAvatarPayload(id);
      expect(payload?.avatar).toBe(engineAvatarMarker(id));
      expect(payload?.avatar_ext).toBe('svg');
      expect(payload?.avatar_data?.length).toBeGreaterThan(20);
      expect(defaultAvatarForEngine(id)).toBe(engineAvatarMarker(id));
    }
  });

  it('falls back for unknown engines', () => {
    expect(defaultAvatarForEngine(null)).toBe(GENERIC_DEFAULT_AVATAR);
    expect(defaultAvatarForEngine('custom-cli')).toBe(GENERIC_DEFAULT_AVATAR);
    expect(loadEngineAvatarPayload('custom-cli')).toBeUndefined();
  });
});
