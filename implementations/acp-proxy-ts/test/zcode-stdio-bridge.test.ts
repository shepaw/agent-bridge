import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ZCODE_RUNTIME_PREFERENCES,
  replyForZcodeServerRequest,
  ZCODE_RUNTIME_PREFERENCES_METHOD,
} from '../src/zcode-runtime-preferences.js';
import { applyZcodeStdioBridge, resolveZcodeAppServerProxy } from '../src/engines.js';

describe('replyForZcodeServerRequest', () => {
  it('answers requestRuntimePreferences with the same id', () => {
    const line = JSON.stringify({
      id: 'server-1',
      method: ZCODE_RUNTIME_PREFERENCES_METHOD,
      params: { sessionId: 'sess_1', scope: 'runtime-materialization' },
    });
    const reply = replyForZcodeServerRequest(line);
    expect(reply).not.toBeNull();
    const parsed = JSON.parse(reply!) as {
      id: string;
      result: typeof DEFAULT_ZCODE_RUNTIME_PREFERENCES;
    };
    expect(parsed.id).toBe('server-1');
    expect(parsed.result).toEqual(DEFAULT_ZCODE_RUNTIME_PREFERENCES);
  });

  it('ignores unrelated JSON-RPC lines', () => {
    expect(replyForZcodeServerRequest('{"id":1,"result":{}}')).toBeNull();
    expect(replyForZcodeServerRequest('not json')).toBeNull();
    expect(
      replyForZcodeServerRequest(
        JSON.stringify({ id: 2, method: 'session/event', params: {} }),
      ),
    ).toBeNull();
  });
});

describe('applyZcodeStdioBridge', () => {
  it('points ZCODE_BIN at the proxy and keeps the real runtime', () => {
    const proxy = resolveZcodeAppServerProxy();
    expect(proxy).toBeTruthy();
    const next = applyZcodeStdioBridge({
      ZCODE_BIN: '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
    });
    expect(next.ZCODE_REAL_BIN).toBe(
      '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
    );
    expect(next.ZCODE_BIN).toBe(proxy);
  });

  it('is idempotent when ZCODE_BIN is already the proxy', () => {
    const proxy = resolveZcodeAppServerProxy();
    expect(proxy).toBeTruthy();
    const once = applyZcodeStdioBridge({
      ZCODE_BIN: '/tmp/zcode.cjs',
    });
    const twice = applyZcodeStdioBridge(once);
    expect(twice.ZCODE_BIN).toBe(proxy);
    expect(twice.ZCODE_REAL_BIN).toBe('/tmp/zcode.cjs');
  });
});
