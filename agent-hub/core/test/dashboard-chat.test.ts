import { describe, expect, it } from 'vitest';

import {
  normalizeDashboardChatMessage,
  resolveDashboardChatSessionId,
} from '../src/instance-acp-rpc.js';

describe('normalizeDashboardChatMessage', () => {
  it('trims a non-empty message', () => {
    expect(normalizeDashboardChatMessage('  hello  ')).toBe('hello');
  });

  it('rejects empty or non-string input', () => {
    expect(() => normalizeDashboardChatMessage('   ')).toThrow(/empty/);
    expect(() => normalizeDashboardChatMessage(1)).toThrow(/string/);
  });
});

describe('resolveDashboardChatSessionId', () => {
  it('keeps a provided session id', () => {
    expect(resolveDashboardChatSessionId('  abc  ')).toBe('abc');
  });

  it('allocates a hub-dash id when omitted', () => {
    const id = resolveDashboardChatSessionId();
    expect(id.startsWith('hub-dash_')).toBe(true);
    expect(id.length).toBeGreaterThan('hub-dash_'.length);
  });
});
