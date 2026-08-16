import { describe, expect, it } from 'vitest';
import {
  buildStorePouchCard,
  pouchCardEnabled,
  prependStorePouchCard,
  resolveHostScopeCardMarkdown,
  resolveStoreDeviceIdFromEnv,
  SCOPE_CARD_SCHEMA_VERSION,
} from '../src/store-pouch-card.js';

describe('pouchCardEnabled', () => {
  it('is off when no store backend is configured', () => {
    expect(pouchCardEnabled({})).toBe(false);
  });

  it('is on when peer store is configured', () => {
    expect(pouchCardEnabled({ SHEPAW_PEER_STORE: '1' })).toBe(true);
  });

  it('respects SHEPAW_STORE_POUCH_CARD=off', () => {
    expect(
      pouchCardEnabled({
        SHEPAW_PEER_STORE: '1',
        SHEPAW_STORE_POUCH_CARD: 'off',
      }),
    ).toBe(false);
  });
});

describe('resolveStoreDeviceIdFromEnv', () => {
  it('prefers SHEPAW_HUB_STORE_DEVICE', () => {
    expect(
      resolveStoreDeviceIdFromEnv({
        SHEPAW_HUB_STORE_DEVICE: '352821253aefdfba',
        NEXUSPOUCH_DEVICE: '680a477ce6563798',
      }),
    ).toBe('352821253aefdfba');
  });

  it('falls back to NEXUSPOUCH_DEVICE', () => {
    expect(
      resolveStoreDeviceIdFromEnv({ NEXUSPOUCH_DEVICE: '680a477ce6563798' }),
    ).toBe('680a477ce6563798');
  });
});

describe('resolveHostScopeCardMarkdown', () => {
  it('returns SHEPAW_SCOPE_CARD when set', () => {
    expect(
      resolveHostScopeCardMarkdown({
        SHEPAW_SCOPE_CARD: '## 当前储物袋作用域\n- host',
      }),
    ).toContain('host');
  });
});

describe('buildStorePouchCard', () => {
  it('is device-scoped and uses cognition space', () => {
    const card = buildStorePouchCard({ deviceId: '352821253aefdfba' });
    expect(card).toContain('## 当前储物袋作用域');
    expect(card).toContain(`v${SCOPE_CARD_SCHEMA_VERSION}`);
    expect(card).toContain('store://<space>/<device_id>/<path>');
    expect(card).toContain('352821253aefdfba');
    expect(card).toContain('`cognition`');
    expect(card).toContain('不要');
    expect(card).not.toMatch(/`memory` — Soul/);
    expect(card).not.toMatch(/用户的袋子|agent 的袋子|你的产物根/);
  });

  it('includes mapped workspace uri when provided', () => {
    const card = buildStorePouchCard({
      deviceId: '352821253aefdfba',
      workspaceUri: 'store://workspaces/352821253aefdfba/Users/foo/proj/',
    });
    expect(card).toContain('store://workspaces/352821253aefdfba/Users/foo/proj/');
    expect(card).toContain('docs/good.md');
  });

  it('does not invent a device id when unknown', () => {
    const card = buildStorePouchCard({});
    expect(card).toContain('禁止编造');
    expect(card).not.toMatch(/store:\/\/files\/[0-9a-f]{16}/);
  });

  it('prefers host Scope Card markdown over local template', () => {
    const card = buildStorePouchCard({
      deviceId: '352821253aefdfba',
      hostCardMarkdown: '## 当前储物袋作用域\n- from host',
    });
    expect(card).toContain('from host');
    expect(card).not.toContain('352821253aefdfba');
  });
});

describe('prependStorePouchCard', () => {
  it('inserts a text block ahead of the user prompt', () => {
    const blocks = prependStorePouchCard(
      [{ type: 'text', text: '放到储物袋' }],
      buildStorePouchCard({ deviceId: 'aabbccddeeff0011' }),
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: 'text' });
    expect((blocks[0] as { text: string }).text).toContain('当前储物袋作用域');
    expect(blocks[1]).toEqual({ type: 'text', text: '放到储物袋' });
  });
});
