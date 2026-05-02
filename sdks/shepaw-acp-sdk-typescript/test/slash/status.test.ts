import { describe, expect, it, vi } from 'vitest';

import type { TaskContext } from '../../src/task-context.js';
import { createStatusHandler } from '../../src/slash/handlers/status.js';
import type { SlashCommandDeps, SlashProviders } from '../../src/slash/types.js';

function makeCtx() {
  return { sendText: vi.fn().mockResolvedValue(undefined) };
}

function makeDeps<C extends Record<string, unknown>>(
  cfg: C,
  providers: SlashProviders = {},
): SlashCommandDeps<C> {
  return {
    cfg,
    providers,
    registerFormHandler: vi.fn(),
  };
}

describe('createStatusHandler', () => {
  it('falls back to cfg when no providers are injected', async () => {
    const h = createStatusHandler();
    const ctx = makeCtx();
    const deps = makeDeps({ model: 'a', permissionMode: 'auto' });
    const ok = await h.handle(ctx as unknown as TaskContext, [], '/status', {}, deps);
    expect(ok).toBe(true);
    const out = ctx.sendText.mock.calls[0]![0] as string;
    expect(out).toMatch(/\*\*Agent status\*\*/);
    expect(out).toMatch(/\*\*Model\*\*: `a`/);
    expect(out).toMatch(/\*\*Permission mode\*\*: `auto`/);
  });

  it('includes account + mcp server list when providers present', async () => {
    const h = createStatusHandler();
    const ctx = makeCtx();
    const deps = makeDeps(
      { model: 'cfg-model' },
      {
        status: {
          summary: vi.fn().mockResolvedValue({
            account: 'user@example.com',
            model: 'provider-model',
            permissionMode: 'strict',
          }),
        },
        mcp: {
          servers: vi
            .fn()
            .mockResolvedValue([{ name: 'fs', status: 'ok' }, { name: 'web', status: 'down' }]),
        },
      },
    );
    await h.handle(ctx as unknown as TaskContext, [], '/status', {}, deps);
    const out = ctx.sendText.mock.calls[0]![0] as string;
    expect(out).toMatch(/\*\*Account\*\*: user@example\.com/);
    // Provider value wins over cfg.
    expect(out).toMatch(/\*\*Model\*\*: `provider-model`/);
    expect(out).toMatch(/\*\*Permission mode\*\*: `strict`/);
    expect(out).toMatch(/- fs: ok/);
    expect(out).toMatch(/- web: down/);
  });

  it('status provider error surfaces inline but does not throw', async () => {
    const h = createStatusHandler();
    const ctx = makeCtx();
    const deps = makeDeps(
      {},
      { status: { summary: vi.fn().mockRejectedValue(new Error('boom')) } },
    );
    await h.handle(ctx as unknown as TaskContext, [], '/status', {}, deps);
    const out = ctx.sendText.mock.calls[0]![0] as string;
    expect(out).toMatch(/Status provider error: boom/);
  });

  it('empty mcp list renders "none configured"', async () => {
    const h = createStatusHandler();
    const ctx = makeCtx();
    const deps = makeDeps(
      {},
      { mcp: { servers: vi.fn().mockResolvedValue([]) } },
    );
    await h.handle(ctx as unknown as TaskContext, [], '/status', {}, deps);
    const out = ctx.sendText.mock.calls[0]![0] as string;
    expect(out).toMatch(/\*\*MCP servers\*\*/);
    expect(out).toMatch(/none configured/);
  });
});
