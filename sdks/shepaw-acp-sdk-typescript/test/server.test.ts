import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import type { AddressInfo } from 'node:net';

import { ACPAgentServer } from '../src/server.js';
import { TaskContext } from '../src/task-context.js';
import type { JsonRpcNotification, JsonRpcResponse } from '../src/types.js';

/**
 * Minimal WS client helper that captures every incoming message.
 * Matches how the Shepaw app talks to an agent.
 */
class TestClient {
  private readonly ws: WebSocket;
  private readonly messages: Array<Record<string, unknown>> = [];
  private nextId = 1;
  private closed = false;

  constructor(url: string, token?: string) {
    const headers: Record<string, string> = {};
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    this.ws = new WebSocket(url, { headers });
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString('utf-8')) as Record<string, unknown>;
      this.messages.push(msg);
    });
    this.ws.on('close', () => {
      this.closed = true;
    });
  }

  async ready(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
  }

  sendRaw(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  async request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<JsonRpcResponse & { result?: T }> {
    const id = this.nextId++;
    this.sendRaw({ jsonrpc: '2.0', id, method, params });
    return (await this.waitFor(
      (m) => typeof m.id === 'number' && m.id === id,
    )) as unknown as JsonRpcResponse & { result?: T };
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.sendRaw({ jsonrpc: '2.0', method, params });
  }

  async waitFor(pred: (msg: Record<string, unknown>) => boolean, timeoutMs = 3000): Promise<Record<string, unknown>> {
    // Return an existing message if one matches.
    const existing = this.messages.find(pred);
    if (existing !== undefined) return existing;
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Client.waitFor timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      const handler = (data: WebSocket.RawData) => {
        const msg = JSON.parse(data.toString('utf-8')) as Record<string, unknown>;
        if (pred(msg)) {
          clearTimeout(timer);
          this.ws.off('message', handler);
          resolve(msg);
        }
      };
      this.ws.on('message', handler);
    });
  }

  async waitForNotification(method: string, timeoutMs = 3000): Promise<JsonRpcNotification> {
    return (await this.waitFor(
      (m) => m.method === method && m.id === undefined,
      timeoutMs,
    )) as unknown as JsonRpcNotification;
  }

  get allMessages(): ReadonlyArray<Record<string, unknown>> {
    return this.messages;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.ws.close();
    await new Promise<void>((resolve) => this.ws.once('close', resolve));
  }
}

async function startAgent(
  agent: ACPAgentServer,
): Promise<{ port: number; stop: () => Promise<void> }> {
  const { httpServer, wsServer } = agent.createServer();

  httpServer.on('upgrade', () => {
    // already wired by createServer
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const port = (httpServer.address() as AddressInfo).port;

  return {
    port,
    stop: async () => {
      await new Promise<void>((resolve) => wsServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await agent.close().catch(() => undefined);
    },
  };
}

// ────────────────────────────────────────────────────────────────────

describe('ACPAgentServer — echo flow', () => {
  class EchoAgent extends ACPAgentServer {
    override async onChat(ctx: TaskContext, message: string): Promise<void> {
      await ctx.sendText(`Echo: ${message}`);
    }
  }

  let port: number;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const agent = new EchoAgent({ name: 'Echo', token: 'secret' });
    const handle = await startAgent(agent);
    port = handle.port;
    stop = handle.stop;
  });

  afterAll(async () => {
    await stop();
  });

  it('completes a chat with task.started → ui.textContent → task.completed', async () => {
    const client = new TestClient(`ws://127.0.0.1:${port}/acp/ws`, 'secret');
    await client.ready();

    const ack = await client.request<{ task_id: string; status: string }>('agent.chat', {
      task_id: 't1',
      session_id: 's1',
      message: 'hi',
    });
    expect(ack.result).toEqual({ task_id: 't1', status: 'accepted' });

    const started = await client.waitForNotification('task.started');
    expect(started.params).toMatchObject({ task_id: 't1' });

    const text = (await client.waitFor(
      (m) =>
        m.method === 'ui.textContent' &&
        (m.params as Record<string, unknown>).is_final === false,
    )) as unknown as JsonRpcNotification;
    expect(text.params).toMatchObject({
      task_id: 't1',
      content: 'Echo: hi',
      is_final: false,
    });

    const textFinal = (await client.waitFor(
      (m) =>
        m.method === 'ui.textContent' &&
        (m.params as Record<string, unknown>).is_final === true,
    )) as unknown as JsonRpcNotification;
    expect(textFinal.params).toMatchObject({ task_id: 't1', is_final: true });

    const completed = await client.waitForNotification('task.completed');
    expect(completed.params).toMatchObject({ task_id: 't1', status: 'success' });

    await client.close();
  });

  it('rejects bad token with -32000', async () => {
    const client = new TestClient(`ws://127.0.0.1:${port}/acp/ws`); // no Authorization header
    await client.ready();
    const authResp = await client.request('auth.authenticate', { token: 'wrong' });
    expect(authResp).toMatchObject({ error: { code: -32000 } });
    await client.close();
  });

  it('ping works even before auth', async () => {
    const client = new TestClient(`ws://127.0.0.1:${port}/acp/ws`);
    await client.ready();
    const pong = await client.request('ping');
    expect(pong.result).toEqual({ pong: true });
    await client.close();
  });

  it('rejects unauthenticated method calls', async () => {
    const client = new TestClient(`ws://127.0.0.1:${port}/acp/ws`);
    await client.ready();
    const resp = await client.request('agent.getCard');
    expect(resp).toMatchObject({ error: { code: -32000 } });
    await client.close();
  });
});

// ────────────────────────────────────────────────────────────────────

describe('ACPAgentServer — cancel + UI interaction', () => {
  let resolveConfirm: ((value: Record<string, unknown>) => void) | undefined;

  class InteractiveAgent extends ACPAgentServer {
    override async onChat(ctx: TaskContext, _message: string): Promise<void> {
      const cid = await ctx.sendActionConfirmation({
        prompt: 'Proceed?',
        actions: [
          { label: 'Yes', value: 'y' },
          { label: 'No', value: 'n' },
        ],
        confirmationId: 'confirm_static',
      });
      const response = await ctx.waitForResponse(cid, { timeoutMs: 5000 });
      resolveConfirm?.(response);
      await ctx.sendText(`result: ${response.value as string}`);
    }
  }

  let port: number;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const agent = new InteractiveAgent({ name: 'Interactive', token: '' }); // no auth
    const handle = await startAgent(agent);
    port = handle.port;
    stop = handle.stop;
  });

  afterAll(async () => {
    await stop();
  });

  it('routes agent.submitResponse back to waitForResponse', async () => {
    const client = new TestClient(`ws://127.0.0.1:${port}/acp/ws`);
    await client.ready();

    const received = new Promise<Record<string, unknown>>((r) => (resolveConfirm = r));

    await client.request('agent.chat', {
      task_id: 't2',
      session_id: 's2',
      message: 'delete this please',
    });

    const confirm = await client.waitForNotification('ui.actionConfirmation', 3000);
    expect(confirm.params).toMatchObject({
      task_id: 't2',
      confirmation_id: 'confirm_static',
      prompt: 'Proceed?',
    });

    const ack = await client.request('agent.submitResponse', {
      task_id: 't2',
      response_type: 'confirmation',
      response_data: { confirmation_id: 'confirm_static', value: 'y' },
    });
    expect(ack.result).toEqual({ task_id: 't2', status: 'received' });

    const payload = await received;
    expect(payload).toMatchObject({ confirmation_id: 'confirm_static', value: 'y' });

    const text = (await client.waitFor(
      (m) =>
        m.method === 'ui.textContent' &&
        (m.params as Record<string, unknown>).is_final === false &&
        typeof (m.params as Record<string, unknown>).content === 'string' &&
        ((m.params as Record<string, unknown>).content as string).includes('result: y'),
    )) as unknown as JsonRpcNotification;
    expect(text).toBeDefined();

    await client.close();
  });
});

// ────────────────────────────────────────────────────────────────────

describe('ACPAgentServer — cancellation', () => {
  class StallAgent extends ACPAgentServer {
    override async onChat(ctx: TaskContext): Promise<void> {
      // Wait for a confirmation that will never come; rely on cancel.
      await ctx.waitForResponse('never_confirmed', { timeoutMs: 60_000 });
    }
  }

  let port: number;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const agent = new StallAgent({ name: 'Stall', token: '' });
    const handle = await startAgent(agent);
    port = handle.port;
    stop = handle.stop;
  });

  afterAll(async () => {
    await stop();
  });

  it('sends task.error with code -32008 on agent.cancelTask', async () => {
    const client = new TestClient(`ws://127.0.0.1:${port}/acp/ws`);
    await client.ready();

    await client.request('agent.chat', { task_id: 't3', session_id: 's3', message: 'stall' });
    await client.waitForNotification('task.started');

    const cancel = await client.request('agent.cancelTask', { task_id: 't3' });
    expect(cancel.result).toMatchObject({ task_id: 't3', status: 'cancelled' });

    const errNotif = await client.waitForNotification('task.error', 3000);
    expect(errNotif.params).toMatchObject({ task_id: 't3', code: -32008 });

    await client.close();
  });
});
