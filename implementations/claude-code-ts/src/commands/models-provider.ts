/**
 * Claude-specific `ModelsProvider` — wraps `query().supportedModels()`
 * with defensive filtering.
 *
 * The Claude SDK declares `SDKControlInitializeResponse.models: ModelInfo[]`
 * with `{ value, displayName, description }`, BUT real CLI versions have
 * occasionally shipped with malformed entries (empty `value` etc.). We
 * filter those out defensively so the radio picker doesn't end up with
 * multiple options that all share `value: ''` (they'd all appear selected
 * simultaneously — a UX disaster we hit with the Tencent SDK earlier).
 *
 * Uses a short-lived warmup `query()` that never sends a prompt — no LLM
 * turn is consumed. Cached for 5 minutes.
 */
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { ModelInfoEntry, ModelsProvider } from 'shepaw-acp-sdk';

import type { QueryFn } from '../agent.js';

export interface ClaudeModelsProviderOptions {
  queryFn: QueryFn;
  cwd: string;
  getCurrentModel?(): string | undefined;
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** Async generator that yields an empty user message — the warmup primer. */
async function* warmupPrompt() {
  yield {
    type: 'user' as const,
    message: { role: 'user' as const, content: '' },
    parent_tool_use_id: null,
    session_id: '',
  } as never;
}

export class ClaudeModelsProvider implements ModelsProvider {
  private cache: ModelInfoEntry[] = [];
  private fetchedAt = 0;
  private readonly ttlMs: number;

  constructor(private readonly opts: ClaudeModelsProviderOptions) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  }

  async list(): Promise<ModelInfoEntry[]> {
    if (this.cache.length > 0 && Date.now() - this.fetchedAt < this.ttlMs) {
      return this.cache;
    }
    const options: Options = { cwd: this.opts.cwd };
    const current = this.opts.getCurrentModel?.();
    if (current !== undefined) options.model = current;

    type QueryLike = {
      connect(): Promise<void>;
      supportedModels(): Promise<Array<{
        value: string;
        displayName: string;
        description: string;
      }>>;
      return(): Promise<unknown>;
    };
    const q = this.opts.queryFn({
      prompt: warmupPrompt(),
      options,
    }) as unknown as QueryLike;

    try {
      await q.connect();
      const raw = await q.supportedModels();
      this.cache = raw
        .filter((m) => typeof m.value === 'string' && m.value.length > 0)
        .map((m) => ({
          id: m.value,
          name: m.displayName || m.value,
          description: m.description ?? '',
        }));
      this.fetchedAt = Date.now();
      return this.cache;
    } finally {
      try {
        await q.return();
      } catch {
        /* ignore */
      }
    }
  }

  invalidate(): void {
    this.cache = [];
    this.fetchedAt = 0;
  }
}
