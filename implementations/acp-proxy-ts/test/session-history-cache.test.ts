import { describe, expect, it, vi } from 'vitest';

import { SessionHistoryCache } from '../src/session-history-cache.js';

describe('SessionHistoryCache', () => {
  it('returns cached messages within TTL', () => {
    const cache = new SessionHistoryCache(60_000);
    const messages = [{ role: 'user' as const, content: 'hi' }];
    cache.set('s1', messages);
    expect(cache.get('s1')).toEqual(messages);
  });

  it('expires entries after TTL', () => {
    vi.useFakeTimers();
    const cache = new SessionHistoryCache(1000);
    cache.set('s1', [{ role: 'agent' as const, content: 'ok' }]);
    vi.advanceTimersByTime(1001);
    expect(cache.get('s1')).toBeUndefined();
    vi.useRealTimers();
  });

  it('invalidate removes a single session', () => {
    const cache = new SessionHistoryCache();
    cache.set('s1', [{ role: 'user' as const, content: 'a' }]);
    cache.set('s2', [{ role: 'user' as const, content: 'b' }]);
    cache.invalidate('s1');
    expect(cache.get('s1')).toBeUndefined();
    expect(cache.get('s2')).toHaveLength(1);
  });
});
