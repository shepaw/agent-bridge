import { describe, expect, it } from 'vitest';
import { StoreToolsClient, executeStoreTool } from '../src/store-tools.js';

const HUB = 'http://hub.test';
const SELF = 'aaaaaaaaaaaaaaaa';
const FOREIGN = 'bbbbbbbbbbbbbbbb';

const ENV = {
  SHEPAW_HUB_STORE_URL: HUB,
  SHEPAW_STORE_AGENT_ID: 'cursor-1',
  SHEPAW_STORE_CONTEXT_FILE: '/tmp/shepaw-test-no-store-context.json',
} as NodeJS.ProcessEnv;

type Call = { url: string; body: Record<string, unknown> };

function clientFor(
  reply: (call: Call) => Record<string, unknown>,
  opts: { env?: NodeJS.ProcessEnv; base?: string } = {},
): { client: StoreToolsClient; calls: Call[] } {
  const calls: Call[] = [];
  const handler = async (url: unknown, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    const body = reply(calls[calls.length - 1]!);
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return {
    client: new StoreToolsClient(
      opts.base ?? HUB,
      'tok',
      SELF,
      handler as unknown as typeof fetch,
      opts.env ?? ENV,
    ),
    calls,
  };
}

const foreignUri = `store://files/${FOREIGN}/docs/a.txt`;
const selfUri = `store://files/${SELF}/docs/a.txt`;

describe('store tools — foreign pouch goes through the App', () => {
  it('reads another device via /api/v1/cli/execute', async () => {
    const { client, calls } = clientFor(() => ({
      ok: true,
      success: true,
      uri: foreignUri,
      size: 5,
      content: 'hello',
    }));
    const out = await executeStoreTool('store_read', { uri: foreignUri }, client);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${HUB}/api/v1/cli/execute`);
    expect(calls[0]!.body).toMatchObject({
      agent_id: 'cursor-1',
      namespace: 'store',
      subcommand: 'read',
      flags: { uri: foreignUri },
    });
    expect(out.ok).toBe(true);
    expect(out.data).toMatchObject({
      uri: foreignUri,
      size: 5,
      encoding: 'text',
      content: 'hello',
    });
  });

  it('keeps base64 payloads flagged as base64', async () => {
    const { client } = clientFor(() => ({
      ok: true,
      uri: foreignUri,
      size: 4,
      content_base64: 'aGVsbG8=',
      encoding: 'base64',
    }));
    const out = await executeStoreTool('store_read', { uri: foreignUri }, client);
    expect(out.data).toMatchObject({
      encoding: 'base64',
      content: 'aGVsbG8=',
    });
  });

  it('lists another device with depth passthrough', async () => {
    const { client, calls } = clientFor(() => ({
      ok: true,
      uri: `store://files/${FOREIGN}/docs`,
      depth: 0,
      entries: [{ path: 'a.txt', kind: 'file' }],
    }));
    const out = await executeStoreTool(
      'store_list',
      { uri: `store://files/${FOREIGN}/docs`, depth: 0 },
      client,
    );
    expect(calls[0]!.url).toBe(`${HUB}/api/v1/cli/execute`);
    expect(calls[0]!.body).toMatchObject({
      subcommand: 'list',
      flags: { uri: `store://files/${FOREIGN}/docs`, depth: '0' },
    });
    expect(out.ok).toBe(true);
    expect((out.data as { entries: unknown[] }).entries).toHaveLength(1);
  });

  it('surfaces an App rejection as a tool error', async () => {
    const { client } = clientFor(() => ({
      ok: false,
      error: "not allowed: store.read",
    }));
    const out = await executeStoreTool('store_read', { uri: foreignUri }, client);
    expect(out).toMatchObject({
      ok: false,
      code: 'app_cli_error',
      error: 'not allowed: store.read',
    });
  });

  it('fails clearly when no executor agent id is known', async () => {
    const { client, calls } = clientFor(() => ({ ok: true }), {
      env: {
        SHEPAW_HUB_STORE_URL: HUB,
        SHEPAW_STORE_CONTEXT_FILE: '/tmp/shepaw-test-no-store-context.json',
      } as NodeJS.ProcessEnv,
    });
    const out = await executeStoreTool('store_read', { uri: foreignUri }, client);
    expect(calls).toHaveLength(0);
    expect(out.ok).toBe(false);
    expect(out.code).toBe('no_agent_id');
  });
});

describe('store tools — local pouch stays on the Hub', () => {
  it('does not forward this device', async () => {
    const { client, calls } = clientFor(() => ({ ok: true }));
    await executeStoreTool('store_read', { uri: selfUri }, client);
    expect(calls[0]!.url).toContain('/api/v1/uri/resolve');
    expect(calls.some((c) => c.url.includes('/api/v1/cli/execute'))).toBe(false);
  });

  it('does not forward when the base is not the peer-store Hub', async () => {
    const { client, calls } = clientFor(() => ({ ok: true }), {
      base: 'http://127.0.0.1:8787',
      env: {
        NEXUSPOUCH_URL: 'http://127.0.0.1:8787',
        SHEPAW_STORE_CONTEXT_FILE: '/tmp/shepaw-test-no-store-context.json',
      } as NodeJS.ProcessEnv,
    });
    await executeStoreTool('store_read', { uri: foreignUri }, client);
    expect(calls[0]!.url).toContain('/api/v1/uri/resolve');
  });

  it('does not forward when the Hub device is unknown', async () => {
    const calls: Call[] = [];
    const handler = async (url: unknown, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return new Response('{}', { status: 200 });
    };
    const client = new StoreToolsClient(
      HUB,
      'tok',
      '0000000000000000',
      handler as unknown as typeof fetch,
      ENV,
    );
    await executeStoreTool('store_read', { uri: foreignUri }, client);
    expect(calls[0]!.url).toContain('/api/v1/uri/resolve');
  });
});
