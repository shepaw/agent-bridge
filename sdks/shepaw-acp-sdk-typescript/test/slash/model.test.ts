import { describe, expect, it, vi } from 'vitest';

import type { TaskContext } from '../../src/task-context.js';
import { createModelHandler } from '../../src/slash/handlers/model.js';
import type {
  ModelInfoEntry,
  ModelsProvider,
  SlashCommandDeps,
} from '../../src/slash/types.js';

interface FakeCtx {
  sendText: ReturnType<typeof vi.fn>;
  sendForm: ReturnType<typeof vi.fn>;
}

function makeCtx(): FakeCtx {
  return {
    sendText: vi.fn().mockResolvedValue(undefined),
    sendForm: vi.fn().mockResolvedValue('form_abc'),
  };
}

function makeDeps<C extends Record<string, unknown>>(overrides: {
  cfg?: C;
  models?: ModelsProvider;
} = {}): SlashCommandDeps<C> & { forms: Map<string, (v: Record<string, unknown>) => void> } {
  const forms = new Map<string, (v: Record<string, unknown>) => void>();
  return {
    cfg: (overrides.cfg ?? ({} as C)) as C,
    providers: { models: overrides.models },
    registerFormHandler(id, fn) {
      forms.set(id, fn as (v: Record<string, unknown>) => void);
    },
    forms,
  };
}

const MODELS: ModelInfoEntry[] = [
  { id: 'a-1', name: 'Alpha One', description: 'first' },
  { id: 'b-2', name: 'Beta Two', description: 'second' },
];

describe('createModelHandler', () => {
  it('name + description + argumentHint exposed for palette', () => {
    const h = createModelHandler({ applyModel: () => undefined });
    expect(h.name).toBe('model');
    expect(h.argumentHint).toBe('[model-id|list]');
    expect(h.description).toMatch(/model/i);
  });

  it('emits "not supported" when no models provider is injected', async () => {
    const h = createModelHandler<Record<string, unknown>>({ applyModel: () => undefined });
    const ctx = makeCtx();
    const deps = makeDeps();
    const ok = await h.handle(
      ctx as unknown as TaskContext,
      [],
      '/model',
      {},
      deps,
    );
    expect(ok).toBe(true);
    expect(ctx.sendText).toHaveBeenCalledTimes(1);
    expect(ctx.sendText.mock.calls[0]![0]).toMatch(/not supported/i);
    expect(ctx.sendForm).not.toHaveBeenCalled();
  });

  it('"/model <id>" directly calls applyModel and sends confirmation', async () => {
    const applyModel = vi.fn().mockReturnValue(MODELS[1]);
    const h = createModelHandler<Record<string, unknown>>({ applyModel });
    const ctx = makeCtx();
    const cfg = { model: 'a-1' };
    const deps = makeDeps({
      cfg,
      models: { list: vi.fn().mockResolvedValue(MODELS) },
    });
    const ok = await h.handle(
      ctx as unknown as TaskContext,
      ['b-2'],
      '/model b-2',
      {},
      deps,
    );
    expect(ok).toBe(true);
    expect(applyModel).toHaveBeenCalledTimes(1);
    expect(applyModel.mock.calls[0]![0]).toBe(cfg);
    expect(applyModel.mock.calls[0]![1]).toBe('b-2');
    expect(ctx.sendForm).not.toHaveBeenCalled();
    expect(ctx.sendText).toHaveBeenCalledTimes(1);
    expect(ctx.sendText.mock.calls[0]![0]).toMatch(/Beta Two/);
  });

  it('"/model <unknown>" sends an "Unknown model" message', async () => {
    const applyModel = vi.fn().mockReturnValue(undefined);
    const h = createModelHandler<Record<string, unknown>>({ applyModel });
    const ctx = makeCtx();
    const deps = makeDeps({
      models: { list: vi.fn().mockResolvedValue(MODELS) },
    });
    const ok = await h.handle(
      ctx as unknown as TaskContext,
      ['zzz'],
      '/model zzz',
      {},
      deps,
    );
    expect(ok).toBe(true);
    expect(ctx.sendText).toHaveBeenCalledWith(
      expect.stringMatching(/Unknown model: `zzz`/),
    );
  });

  it('"/model" (no args) renders radio picker and registers form handler', async () => {
    const applyModel = vi.fn();
    const h = createModelHandler<Record<string, unknown>>({ applyModel });
    const ctx = makeCtx();
    const cfg = { model: 'a-1' };
    const deps = makeDeps({
      cfg,
      models: { list: vi.fn().mockResolvedValue(MODELS) },
    });
    const ok = await h.handle(
      ctx as unknown as TaskContext,
      [],
      '/model',
      {},
      deps,
    );
    expect(ok).toBe(true);
    expect(ctx.sendForm).toHaveBeenCalledTimes(1);

    const formArg = ctx.sendForm.mock.calls[0]![0];
    expect(formArg.fields[0].type).toBe('radio_group');
    expect(formArg.fields[0].default).toBe('a-1');
    expect(formArg.fields[0].options).toEqual([
      { label: 'Alpha One', value: 'a-1', description: 'first' },
      { label: 'Beta Two', value: 'b-2', description: 'second' },
    ]);

    // Submit — applyModel should fire with the chosen id.
    expect(deps.forms.size).toBe(1);
    const [formId, handler] = [...deps.forms.entries()][0]!;
    expect(formId).toBe(formArg.formId);
    await handler({ choice: 'b-2' });
    expect(applyModel).toHaveBeenCalledWith(cfg, 'b-2', MODELS);
  });

  it('"/model list" also renders picker (same branch)', async () => {
    const h = createModelHandler<Record<string, unknown>>({ applyModel: () => undefined });
    const ctx = makeCtx();
    const deps = makeDeps({
      models: { list: vi.fn().mockResolvedValue(MODELS) },
    });
    await h.handle(ctx as unknown as TaskContext, ['list'], '/model list', {}, deps);
    expect(ctx.sendForm).toHaveBeenCalledTimes(1);
  });

  it('empty provider list sends a plain text message, no form', async () => {
    const h = createModelHandler<Record<string, unknown>>({ applyModel: () => undefined });
    const ctx = makeCtx();
    const deps = makeDeps({
      models: { list: vi.fn().mockResolvedValue([]) },
    });
    await h.handle(ctx as unknown as TaskContext, [], '/model', {}, deps);
    expect(ctx.sendForm).not.toHaveBeenCalled();
    expect(ctx.sendText).toHaveBeenCalledWith(expect.stringMatching(/No models/i));
  });

  it('provider error surfaces as plain text', async () => {
    const h = createModelHandler<Record<string, unknown>>({ applyModel: () => undefined });
    const ctx = makeCtx();
    const deps = makeDeps({
      models: { list: vi.fn().mockRejectedValue(new Error('boom')) },
    });
    await h.handle(ctx as unknown as TaskContext, [], '/model', {}, deps);
    expect(ctx.sendText).toHaveBeenCalledWith(expect.stringMatching(/Failed to fetch models.*boom/));
  });
});
