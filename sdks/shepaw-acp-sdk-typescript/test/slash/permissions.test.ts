import { describe, expect, it, vi } from 'vitest';

import type { TaskContext } from '../../src/task-context.js';
import { createPermissionsHandler } from '../../src/slash/handlers/permissions.js';
import type {
  PermissionModeInfo,
  PermissionsProvider,
  SlashCommandDeps,
} from '../../src/slash/types.js';

function makeCtx() {
  return {
    sendText: vi.fn().mockResolvedValue(undefined),
    sendForm: vi.fn().mockResolvedValue('form_xyz'),
  };
}

function makeDeps<C extends Record<string, unknown>>(overrides: {
  cfg?: C;
  permissions?: PermissionsProvider;
} = {}): SlashCommandDeps<C> & { forms: Map<string, (v: Record<string, unknown>) => void> } {
  const forms = new Map<string, (v: Record<string, unknown>) => void>();
  return {
    cfg: (overrides.cfg ?? ({} as C)) as C,
    providers: { permissions: overrides.permissions },
    registerFormHandler(id, fn) {
      forms.set(id, fn as (v: Record<string, unknown>) => void);
    },
    forms,
  };
}

const MODES: PermissionModeInfo[] = [
  { id: 'auto', name: 'Auto', description: 'automatic' },
  { id: 'strict', name: 'Strict', description: 'ask first' },
];

describe('createPermissionsHandler', () => {
  it('name + alias exposed', () => {
    const h = createPermissionsHandler({ applyMode: () => undefined });
    expect(h.name).toBe('permissions');
    expect(h.aliases).toEqual(['mode']);
  });

  it('no provider → "not supported"', async () => {
    const h = createPermissionsHandler<Record<string, unknown>>({ applyMode: () => undefined });
    const ctx = makeCtx();
    const deps = makeDeps();
    await h.handle(ctx as unknown as TaskContext, [], '/permissions', {}, deps);
    expect(ctx.sendText.mock.calls[0]![0]).toMatch(/not supported/i);
    expect(ctx.sendForm).not.toHaveBeenCalled();
  });

  it('"/permissions <id>" calls applyMode and sends confirmation', async () => {
    const applyMode = vi.fn().mockReturnValue(MODES[1]);
    const h = createPermissionsHandler<Record<string, unknown>>({ applyMode });
    const ctx = makeCtx();
    const cfg = { permissionMode: 'auto' };
    const deps = makeDeps({
      cfg,
      permissions: { modes: vi.fn().mockResolvedValue(MODES) },
    });
    await h.handle(
      ctx as unknown as TaskContext,
      ['strict'],
      '/permissions strict',
      {},
      deps,
    );
    expect(applyMode).toHaveBeenCalledWith(cfg, 'strict', MODES);
    expect(ctx.sendText.mock.calls[0]![0]).toMatch(/Strict/);
  });

  it('picker form submit forwards choice to applyMode', async () => {
    const applyMode = vi.fn();
    const h = createPermissionsHandler<Record<string, unknown>>({ applyMode });
    const ctx = makeCtx();
    const cfg = { permissionMode: 'auto' };
    const deps = makeDeps({
      cfg,
      permissions: { modes: vi.fn().mockResolvedValue(MODES) },
    });
    await h.handle(ctx as unknown as TaskContext, [], '/permissions', {}, deps);
    expect(ctx.sendForm).toHaveBeenCalledTimes(1);
    const [, handler] = [...deps.forms.entries()][0]!;
    await handler({ choice: 'strict' });
    expect(applyMode).toHaveBeenCalledWith(cfg, 'strict', MODES);
  });

  it('unknown id yields "Unknown permission mode"', async () => {
    const h = createPermissionsHandler<Record<string, unknown>>({
      applyMode: () => undefined,
    });
    const ctx = makeCtx();
    const deps = makeDeps({
      permissions: { modes: vi.fn().mockResolvedValue(MODES) },
    });
    await h.handle(
      ctx as unknown as TaskContext,
      ['nope'],
      '/permissions nope',
      {},
      deps,
    );
    expect(ctx.sendText.mock.calls[0]![0]).toMatch(/Unknown permission mode: `nope`/);
  });
});
