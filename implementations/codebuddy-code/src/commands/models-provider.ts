/**
 * Codebuddy-specific `ModelsProvider` — fetches models from the Tencent
 * Agent SDK via a short-lived `createSession()`.
 *
 * Why `createSession().getAvailableModels()` and not
 * `query.supportedModels()`? The latter reads `response.models` on the
 * `initialize` control response, but the CLI protocol doesn't populate
 * that field (only `currentModelId`). It always returns `[]`. The real
 * data comes from `session.getAvailableModels()`, which issues a
 * dedicated `get_available_models` control request and returns entries
 * shaped as `{ modelId, name, description? }` — we remap to the SDK's
 * `ModelInfoEntry` shape (`{ id, name, description? }`).
 *
 * Cached for 5 minutes. No LLM turn is consumed — we connect the CLI
 * subprocess, ask for the model list, and close.
 */
import {
  unstable_v2_createSession as createSession,
  type Options,
} from '@tencent-ai/agent-sdk';
import type { ModelInfoEntry, ModelsProvider } from 'shepaw-acp-sdk';

export interface CodeBuddyModelsProviderOptions {
  cwd: string;
  environment?: Options['environment'];
  endpoint?: string;
  /** Currently-selected model id (if any) — forwarded to session init. */
  getCurrentModel?(): string | undefined;
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class CodeBuddyModelsProvider implements ModelsProvider {
  private cache: ModelInfoEntry[] = [];
  private fetchedAt = 0;
  private readonly ttlMs: number;

  constructor(private readonly opts: CodeBuddyModelsProviderOptions) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  }

  async list(): Promise<ModelInfoEntry[]> {
    if (this.cache.length > 0 && Date.now() - this.fetchedAt < this.ttlMs) {
      return this.cache;
    }
    const sessionOpts: Parameters<typeof createSession>[0] = { cwd: this.opts.cwd };
    const current = this.opts.getCurrentModel?.();
    if (current !== undefined) sessionOpts.model = current;
    if (this.opts.environment !== undefined) sessionOpts.environment = this.opts.environment;
    if (this.opts.endpoint !== undefined) sessionOpts.endpoint = this.opts.endpoint;

    const session = createSession(sessionOpts);
    try {
      await session.connect();
      const raw = await session.getAvailableModels();
      this.cache = raw.map((m) => ({
        id: m.modelId,
        name: m.name,
        description: m.description ?? '',
      }));
      this.fetchedAt = Date.now();
      return this.cache;
    } finally {
      try {
        session.close();
      } catch {
        /* ignore */
      }
    }
  }

  /** Force a cache drop — useful after an out-of-band change. */
  invalidate(): void {
    this.cache = [];
    this.fetchedAt = 0;
  }

  /** Read-only access — used by the JSON-RPC `agent.models.list` path. */
  get snapshot(): ReadonlyArray<ModelInfoEntry> {
    return this.cache;
  }
}
