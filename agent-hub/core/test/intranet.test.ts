import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listEngineInfos } from '../src/engines.js';
import {
  detectTencentIntranet,
  isIntranetEngineVisible,
  isIntranetOnlyEngine,
  resetTencentIntranetCacheForTests,
  TENCENT_INTRANET_ENV,
} from '../src/intranet.js';

const INTRANET_IDS = ['tclaude', 'tcodex', 'knot'] as const;
const PUBLIC_ID = 'claude-code';

describe('tencent intranet catalog', () => {
  const prev = process.env[TENCENT_INTRANET_ENV];

  beforeEach(() => {
    resetTencentIntranetCacheForTests();
    delete process.env[TENCENT_INTRANET_ENV];
  });

  afterEach(() => {
    resetTencentIntranetCacheForTests();
    if (prev === undefined) delete process.env[TENCENT_INTRANET_ENV];
    else process.env[TENCENT_INTRANET_ENV] = prev;
  });

  it('flags only tclaude / tcodex / knot', () => {
    for (const id of INTRANET_IDS) {
      expect(isIntranetOnlyEngine(id)).toBe(true);
    }
    expect(isIntranetOnlyEngine(PUBLIC_ID)).toBe(false);
    expect(isIntranetOnlyEngine('custom-cli')).toBe(false);
  });

  it('hides intranet engines until a probe or override says otherwise', () => {
    expect(isIntranetEngineVisible(PUBLIC_ID)).toBe(true);
    for (const id of INTRANET_IDS) {
      expect(isIntranetEngineVisible(id)).toBe(false);
    }
    const listed = listEngineInfos([], undefined, { resolveCommands: false }).map((e) => e.id);
    expect(listed).toContain(PUBLIC_ID);
    expect(listed).not.toContain('tclaude');
    expect(listed).not.toContain('tcodex');
    expect(listed).not.toContain('knot');
  });

  it('shows intranet engines when SHEPAW_HUB_TENCENT_INTRANET=1', async () => {
    process.env[TENCENT_INTRANET_ENV] = '1';
    await expect(detectTencentIntranet()).resolves.toBe(true);
    for (const id of INTRANET_IDS) {
      expect(isIntranetEngineVisible(id)).toBe(true);
    }
    const listed = listEngineInfos([], undefined, { resolveCommands: false }).map((e) => e.id);
    expect(listed).toEqual(expect.arrayContaining([...INTRANET_IDS]));
  });

  it('keeps intranet engines hidden when SHEPAW_HUB_TENCENT_INTRANET=0', async () => {
    process.env[TENCENT_INTRANET_ENV] = '0';
    await expect(detectTencentIntranet()).resolves.toBe(false);
    for (const id of INTRANET_IDS) {
      expect(isIntranetEngineVisible(id)).toBe(false);
    }
    expect(
      listEngineInfos([], undefined, { includeIntranetOnly: true, resolveCommands: false }).map((e) => e.id),
    ).toEqual(expect.arrayContaining([...INTRANET_IDS]));
  });

  it('keeps an intranet engine listed when an instance already uses it', () => {
    const listed = listEngineInfos([], undefined, {
      resolveCommands: false,
      usedEngineIds: ['tclaude'],
    }).map((e) => e.id);
    expect(listed).toContain('tclaude');
    expect(listed).not.toContain('tcodex');
    expect(listed).not.toContain('knot');
  });
});
