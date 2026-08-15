import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ZCODE_PROVIDER_RUNTIME_HEADERS,
  DEFAULT_ZCODE_RUNTIME_PREFERENCES,
  replyForZcodeServerRequest,
  ZCODE_PROVIDER_RUNTIME_HEADERS_METHOD,
  ZCODE_RUNTIME_PREFERENCES_METHOD,
} from '../src/zcode-runtime-preferences.js';
import { applyZcodeStdioBridge, resolveZcodeAppServerProxy } from '../src/engines.js';
import {
  buildZcodeRuntimeModel,
  ZcodeStdioInterceptor,
  ZCODE_UPDATE_RUNTIME_MODEL_METHOD,
} from '../src/zcode-stdio-interceptor.js';
import type { ZcodeDesktopCredentials } from '../src/zcode-desktop-credentials.js';

const codingPlanCreds: ZcodeDesktopCredentials = {
  providerId: 'builtin:bigmodel-coding-plan',
  kind: 'anthropic',
  modelId: 'GLM-5.3',
  modelVariant: 'low',
  models: ['GLM-5.3'],
  modelCatalog: [
    {
      modelId: 'GLM-5.3',
      reasoning: {
        enabled: true,
        defaultLevel: 'low',
        levels: [
          { value: 'low', label: 'low' },
          { value: 'high', label: 'high' },
          { value: 'max', label: 'max' },
        ],
      },
    },
  ],
  planEndpoint: false,
  ZCODE_MODEL: 'builtin:bigmodel-coding-plan/GLM-5.3',
  ZCODE_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
  ANTHROPIC_API_KEY: 'coding-key',
};

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

  it('answers requestProviderRuntimeHeaders with headersApplied', () => {
    const line = JSON.stringify({
      id: 'server-3',
      method: ZCODE_PROVIDER_RUNTIME_HEADERS_METHOD,
      params: {
        requestId: 'sess_1:provider-runtime-headers:1',
        sessionId: 'sess_1',
        providerId: 'builtin:bigmodel-start-plan',
        reason: 'model-request',
      },
    });
    const reply = replyForZcodeServerRequest(line);
    expect(reply).not.toBeNull();
    const parsed = JSON.parse(reply!) as {
      id: string;
      result: typeof DEFAULT_ZCODE_PROVIDER_RUNTIME_HEADERS;
    };
    expect(parsed.id).toBe('server-3');
    expect(parsed.result).toEqual(DEFAULT_ZCODE_PROVIDER_RUNTIME_HEADERS);
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

describe('ZcodeStdioInterceptor', () => {
  it('injects updateRuntimeModelConfig after session/create', () => {
    const bridge = new ZcodeStdioInterceptor(codingPlanCreds);
    bridge.inbound(JSON.stringify({ id: 7, method: 'session/create', params: { mode: 'yolo' } }));
    const held = bridge.outbound(
      JSON.stringify({ id: 7, result: { session: { sessionId: 'sess_1' } } }),
    );
    expect(held.forward).toBeUndefined();
    expect(held.holdCreate).toBe(true);
    const injected = JSON.parse(held.toChild!) as {
      id: string;
      method: string;
      params: { sessionId: string; runtimeModel: { provider: { apiKey: unknown } } };
    };
    expect(injected.method).toBe(ZCODE_UPDATE_RUNTIME_MODEL_METHOD);
    expect(injected.params.sessionId).toBe('sess_1');
    expect('jsonrpc' in injected).toBe(false);
    expect(injected.params.runtimeModel.provider.apiKey).toEqual({
      source: 'env',
      name: 'ANTHROPIC_API_KEY',
    });

    const afterRm = bridge.outbound(JSON.stringify({ id: injected.id, result: { changed: true } }));
    expect(afterRm.forward).toBeUndefined();
    const setModel = JSON.parse(afterRm.toChild!) as { id: string; method: string };
    expect(setModel.method).toBe('session/setModel');
    const afterSm = bridge.outbound(JSON.stringify({ id: setModel.id, result: {} }));
    const thought = JSON.parse(afterSm.toChild!) as { id: string; method: string; params: { thoughtLevel: string } };
    expect(thought.method).toBe('session/setThoughtLevel');
    expect(thought.params.thoughtLevel).toBe('low');
    const done = bridge.outbound(JSON.stringify({ id: thought.id, result: {} }));
    expect(JSON.parse(done.forward!).id).toBe(7);
  });

  it('rewrites resume runtimeModel onto the API-key provider', () => {
    const bridge = new ZcodeStdioInterceptor(codingPlanCreds);
    const line = bridge.inbound(
      JSON.stringify({
        id: 8,
        method: 'session/resume',
        params: { sessionId: 'sess_1', runtimeModel: { revision: 'stale' } },
      }),
    );
    const parsed = JSON.parse(line) as { params: { runtimeModel: ReturnType<typeof buildZcodeRuntimeModel> } };
    expect(parsed.params.runtimeModel.model).toEqual({
      providerId: 'builtin:bigmodel-coding-plan',
      modelId: 'GLM-5.3',
      variant: 'low',
    });
    expect(parsed.params.runtimeModel.thoughtLevel).toBe('low');
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
