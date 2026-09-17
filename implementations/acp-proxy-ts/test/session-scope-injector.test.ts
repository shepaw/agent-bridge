import { describe, expect, it } from 'vitest';

import {
  buildSessionNewScopeMeta,
  engineSupportsSystemScopeCard,
  resolveScopeCardChannel,
} from '../src/session-scope-injector.js';
import { buildStorePouchCard } from '../src/store-pouch-card.js';

describe('engineSupportsSystemScopeCard', () => {
  it('includes Claude Code family, OpenCode, and Cursor', () => {
    expect(engineSupportsSystemScopeCard('claude-code')).toBe(true);
    expect(engineSupportsSystemScopeCard('tclaude')).toBe(true);
    expect(engineSupportsSystemScopeCard('opencode')).toBe(true);
    expect(engineSupportsSystemScopeCard('cursor')).toBe(true);
  });

  it('excludes engines without a known system hook', () => {
    expect(engineSupportsSystemScopeCard('codex')).toBe(false);
    expect(engineSupportsSystemScopeCard('zcode')).toBe(false);
  });
});

describe('resolveScopeCardChannel', () => {
  it('auto picks system for Claude Code', () => {
    expect(
      resolveScopeCardChannel('claude-code', { SHEPAW_SCOPE_CARD_MODE: 'auto' }),
    ).toBe('system');
  });

  it('auto picks user for unsupported engines', () => {
    expect(resolveScopeCardChannel('codex', {})).toBe('user');
  });

  it('honors explicit overrides', () => {
    expect(
      resolveScopeCardChannel('codex', { SHEPAW_SCOPE_CARD_MODE: 'system' }),
    ).toBe('system');
    expect(
      resolveScopeCardChannel('claude-code', { SHEPAW_SCOPE_CARD_MODE: 'user' }),
    ).toBe('user');
  });
});

describe('buildSessionNewScopeMeta', () => {
  it('returns append systemPrompt meta', () => {
    const card = buildStorePouchCard({ deviceId: 'abc' });
    expect(buildSessionNewScopeMeta(card)).toEqual({
      systemPrompt: { append: card },
    });
  });

  it('returns undefined for blank card', () => {
    expect(buildSessionNewScopeMeta('   ')).toBeUndefined();
  });
});
