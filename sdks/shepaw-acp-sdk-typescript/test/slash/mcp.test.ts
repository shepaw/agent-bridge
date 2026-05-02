import { describe, expect, it, vi } from 'vitest';

import type { TaskContext } from '../../src/task-context.js';
import { createMcpHandler } from '../../src/slash/handlers/mcp.js';
import type { SlashCommandDeps, SlashProviders } from '../../src/slash/types.js';

function makeCtx() {
  return { sendText: vi.fn().mockResolvedValue(undefined) };
}

function makeDeps(providers: SlashProviders = {}): SlashCommandDeps<Record<string, unknown>> {
  return { cfg: {}, providers, registerFormHandler: vi.fn() };
}

describe('createMcpHandler', () => {
  it('no provider → graceful "not supported" text', async () => {
    const h = createMcpHandler();
    const ctx = makeCtx();
    await h.handle(ctx as unknown as TaskContext, [], '/mcp', {}, makeDeps());
    expect(ctx.sendText).toHaveBeenCalledWith(expect.stringMatching(/not supported/i));
  });

  it('lists servers from provider', async () => {
    const h = createMcpHandler();
    const ctx = makeCtx();
    const deps = makeDeps({
      mcp: {
        servers: vi.fn().mockResolvedValue([
          { name: 'fs', status: 'ok' },
          { name: 'web', status: 'error' },
        ]),
      },
    });
    await h.handle(ctx as unknown as TaskContext, [], '/mcp', {}, deps);
    const out = ctx.sendText.mock.calls[0]![0] as string;
    expect(out).toMatch(/\*\*MCP servers\*\*/);
    expect(out).toMatch(/- fs: ok/);
    expect(out).toMatch(/- web: error/);
  });

  it('empty server list → "none configured"', async () => {
    const h = createMcpHandler();
    const ctx = makeCtx();
    const deps = makeDeps({ mcp: { servers: vi.fn().mockResolvedValue([]) } });
    await h.handle(ctx as unknown as TaskContext, [], '/mcp', {}, deps);
    expect(ctx.sendText.mock.calls[0]![0]).toMatch(/none configured/);
  });

  it('provider error surfaces as plain text', async () => {
    const h = createMcpHandler();
    const ctx = makeCtx();
    const deps = makeDeps({
      mcp: { servers: vi.fn().mockRejectedValue(new Error('down')) },
    });
    await h.handle(ctx as unknown as TaskContext, [], '/mcp', {}, deps);
    expect(ctx.sendText.mock.calls[0]![0]).toMatch(/Failed to fetch MCP servers.*down/);
  });
});
