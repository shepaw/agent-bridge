import { describe, expect, it, vi } from 'vitest';

import type { TaskContext } from '../../src/task-context.js';
import { SlashCommandRegistry } from '../../src/slash/registry.js';
import type { SlashCommandHandler } from '../../src/slash/types.js';

function makeHandler(
  name: string,
  overrides: Partial<SlashCommandHandler> = {},
): SlashCommandHandler {
  return {
    name,
    description: `handler ${name}`,
    handle: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

// Minimal fake TaskContext — handlers aren't invoked with real methods in
// these unit tests; we only care about dispatch routing.
const fakeCtx = {} as unknown as TaskContext;

describe('SlashCommandRegistry', () => {
  it('register + has + get work by primary name', () => {
    const r = new SlashCommandRegistry();
    const h = makeHandler('model');
    r.register(h);
    expect(r.has('model')).toBe(true);
    expect(r.has('status')).toBe(false);
    expect(r.get('model')).toBe(h);
  });

  it('aliases route to the same handler object', () => {
    const r = new SlashCommandRegistry();
    const h = makeHandler('permissions', { aliases: ['mode', 'perm'] });
    r.register(h);
    expect(r.get('permissions')).toBe(h);
    expect(r.get('mode')).toBe(h);
    expect(r.get('perm')).toBe(h);
  });

  it('listPrimary dedupes by object identity', () => {
    const r = new SlashCommandRegistry();
    const h = makeHandler('permissions', { aliases: ['mode', 'perm'] });
    r.register(h).register(makeHandler('model'));
    const primary = r.listPrimary();
    expect(primary).toHaveLength(2);
    expect(primary.map((x) => x.name).sort()).toEqual(['model', 'permissions']);
  });

  it('dispatch returns false for unknown name (fall-through to LLM)', async () => {
    const r = new SlashCommandRegistry();
    r.register(makeHandler('model'));
    const result = await r.dispatch(
      fakeCtx,
      'compact',
      [],
      '/compact',
      {},
      { cfg: {}, providers: {}, registerFormHandler: () => {} },
    );
    expect(result).toBe(false);
  });

  it('dispatch forwards args + cfg + providers to the handler', async () => {
    const r = new SlashCommandRegistry();
    const handleSpy = vi.fn().mockResolvedValue(true);
    r.register({
      name: 'model',
      description: 'd',
      handle: handleSpy,
    });

    const cfg = { model: 'x' };
    const providers = { models: undefined };
    const register = vi.fn();

    const result = await r.dispatch(
      fakeCtx,
      'model',
      ['list'],
      '/model list',
      { user_id: 'u' },
      { cfg, providers, registerFormHandler: register },
    );
    expect(result).toBe(true);
    expect(handleSpy).toHaveBeenCalledTimes(1);
    const call = handleSpy.mock.calls[0]!;
    expect(call[0]).toBe(fakeCtx);
    expect(call[1]).toEqual(['list']);
    expect(call[2]).toBe('/model list');
    expect(call[3]).toEqual({ user_id: 'u' });
    expect(call[4].cfg).toBe(cfg);
    expect(call[4].providers).toBe(providers);
    expect(call[4].registerFormHandler).toBe(register);
  });

  it('dispatch honors handler false return (handler chooses not to handle)', async () => {
    const r = new SlashCommandRegistry();
    r.register({
      name: 'model',
      description: 'd',
      handle: async () => false,
    });
    const result = await r.dispatch(
      fakeCtx,
      'model',
      [],
      '/model',
      {},
      { cfg: {}, providers: {}, registerFormHandler: () => {} },
    );
    expect(result).toBe(false);
  });
});
