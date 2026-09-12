import { describe, expect, it } from 'vitest';
import {
  appCliRespToEnvelope,
  buildCliExecutePayload,
  hubForwardEnabled,
  postCliExecute,
  resolveHubDeviceId,
} from '../src/shepaw-cli-forward.js';

/** Never read the gateway's real per-turn context file. */
const ISOLATED_ENV = {
  SHEPAW_STORE_CONTEXT_FILE: '/tmp/shepaw-test-no-store-context.json',
} as NodeJS.ProcessEnv;

describe('hubForwardEnabled', () => {
  it('needs a Hub store backend', () => {
    expect(hubForwardEnabled({})).toBe(false);
    expect(
      hubForwardEnabled({ SHEPAW_HUB_STORE_URL: 'http://127.0.0.1:18792' }),
    ).toBe(true);
  });

  it('honours the opt-out flag', () => {
    expect(
      hubForwardEnabled({
        SHEPAW_HUB_STORE_URL: 'http://127.0.0.1:18792',
        SHEPAW_HUB_CLI_FORWARD: '0',
      }),
    ).toBe(false);
  });
});

describe('resolveHubDeviceId', () => {
  it('prefers the explicit env device', async () => {
    await expect(
      resolveHubDeviceId({ SHEPAW_HUB_STORE_DEVICE: 'ABCDEF0123456789' }),
    ).resolves.toBe('abcdef0123456789');
  });

  it('falls back to Hub health', async () => {
    const device = await resolveHubDeviceId(
      { SHEPAW_HUB_STORE_URL: 'http://hub.test' },
      (async () =>
        new Response(JSON.stringify({ device: 'AABBCCDDEEFF0011' }), {
          status: 200,
        })) as unknown as typeof fetch,
    );
    expect(device).toBe('aabbccddeeff0011');
  });

  it('is empty when the Hub is unreachable', async () => {
    const device = await resolveHubDeviceId(
      { SHEPAW_HUB_STORE_URL: 'http://hub.test' },
      (async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
    );
    expect(device).toBe('');
  });
});

describe('buildCliExecutePayload', () => {
  it('takes agent id and session from the trusted turn context', () => {
    const out = buildCliExecutePayload({
      namespace: 'os',
      subcommand: 'file.read',
      flags: { path: '/tmp/a.txt' },
      env: {
        ...ISOLATED_ENV,
        SHEPAW_STORE_AGENT_ID: 'cursor-1',
        SHEPAW_STORE_CHANNEL: 'dm_abc',
      },
    });
    expect(out).toEqual({
      ok: true,
      payload: {
        agent_id: 'cursor-1',
        namespace: 'os',
        subcommand: 'file.read',
        flags: { path: '/tmp/a.txt' },
        session_id: 'dm_abc',
      },
    });
  });

  it('ignores caller-supplied agent_id (App sanitizes identity)', () => {
    const out = buildCliExecutePayload({
      namespace: 'store',
      subcommand: 'read',
      flags: {
        uri: 'store://runtime/bbbbbbbbbbbbbbbb/x/y.md',
        agent_id: 'forged',
        owner: 'someone-else',
      },
      env: { ...ISOLATED_ENV, SHEPAW_STORE_AGENT_ID: 'cursor-1' },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.payload.agent_id).toBe('cursor-1');
    expect(out.payload.session_id).toBeUndefined();
  });

  it('fails when no executor agent id is known', () => {
    const out = buildCliExecutePayload({
      namespace: 'os',
      subcommand: 'file.read',
      flags: {},
      env: ISOLATED_ENV,
    });
    expect(out.ok).toBe(false);
  });
});

describe('postCliExecute', () => {
  it('POSTs to the Hub cli execute endpoint', async () => {
    let seenUrl = '';
    let seenBody = '';
    const out = await postCliExecute(
      {
        agent_id: 'cursor-1',
        namespace: 'store',
        subcommand: 'read',
        flags: {},
      },
      {
        env: { SHEPAW_HUB_STORE_URL: 'http://hub.test/' },
        fetchImpl: (async (url: string, init?: RequestInit) => {
          seenUrl = url;
          seenBody = String(init?.body ?? '');
          return new Response(JSON.stringify({ ok: true, content: 'hi' }), {
            status: 200,
          });
        }) as unknown as typeof fetch,
      },
    );
    expect(seenUrl).toBe('http://hub.test/api/v1/cli/execute');
    expect(JSON.parse(seenBody)).toMatchObject({ agent_id: 'cursor-1' });
    expect(out).toEqual({ ok: true, content: 'hi' });
  });

  it('reports a non-JSON failure', async () => {
    const out = await postCliExecute(
      { agent_id: 'cursor-1' },
      {
        env: { SHEPAW_HUB_STORE_URL: 'http://hub.test' },
        fetchImpl: (async () =>
          new Response('nope', { status: 500 })) as unknown as typeof fetch,
      },
    );
    expect(out).toEqual({ ok: false, error: 'nope' });
  });
});

describe('appCliRespToEnvelope', () => {
  it('maps an App success onto success', () => {
    expect(appCliRespToEnvelope({ ok: true, content: 'hi' })).toMatchObject({
      success: true,
      content: 'hi',
    });
  });

  it('maps an App rejection onto an error envelope', () => {
    expect(
      appCliRespToEnvelope({ ok: false, error: 'not allowed: os.file.read' }),
    ).toMatchObject({
      success: false,
      error: 'not allowed: os.file.read',
    });
  });
});
