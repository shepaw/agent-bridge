/**
 * Claude-specific `StatusProvider` — fetches the authenticated account info
 * and current model/permissionMode via a short-lived warmup `query()`.
 *
 * Uses the same warmup pattern as `ClaudeModelsProvider`: emit an empty user
 * message so the SDK enters streaming-input mode, call `connect()`, then use
 * the control-request methods (`accountInfo()`, `mcpServerStatus()`) before
 * closing the generator with `return()`.
 *
 * No LLM turn is consumed — the generator is closed before the model ever
 * starts generating. Cached for 5 minutes.
 */
import type { StatusProvider, StatusSummary } from 'shepaw-acp-sdk';
import type { QueryFn } from '../agent.js';

export interface ClaudeStatusProviderOptions {
  queryFn: QueryFn;
  cwd: string;
  /** Currently-selected model id — forwarded to the warmup query. */
  getCurrentModel?(): string | undefined;
  /** Current permission mode from cfg — used as fallback. */
  getCurrentPermissionMode?(): string | undefined;
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** Empty warmup prompt — lets the SDK enter streaming-input mode. */
async function* warmupPrompt() {
  yield {
    type: 'user' as const,
    message: { role: 'user' as const, content: '' },
    parent_tool_use_id: null,
    session_id: '',
  } as never;
}

type QueryLike = {
  connect?: () => Promise<void>;
  accountInfo(): Promise<{
    email?: string;
    organization?: string;
    subscriptionType?: string;
    tokenSource?: string;
    apiKeySource?: string;
    apiProvider?: string;
  }>;
  return?: () => Promise<unknown>;
  close?: () => void;
};

export class ClaudeStatusProvider implements StatusProvider {
  private cache: StatusSummary | undefined;
  private fetchedAt = 0;
  private readonly ttlMs: number;

  constructor(private readonly opts: ClaudeStatusProviderOptions) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  }

  async summary(): Promise<StatusSummary> {
    if (this.cache !== undefined && Date.now() - this.fetchedAt < this.ttlMs) {
      return this.cache;
    }

    const currentModel = this.opts.getCurrentModel?.();
    const currentPermissionMode = this.opts.getCurrentPermissionMode?.();

    const options: Parameters<QueryFn>[0]['options'] = { cwd: this.opts.cwd };
    if (currentModel !== undefined) options!.model = currentModel;

    const q = this.opts.queryFn({
      prompt: warmupPrompt(),
      options,
    }) as unknown as QueryLike;

    try {
      // Recent SDK versions drop explicit connect(); only call it if present.
      if (typeof q.connect === 'function') {
        await q.connect();
      }

      let account: string | undefined;
      try {
        const info = await q.accountInfo();
        // Show email if available, else organization, else subscription type.
        account = info.email ?? info.organization ?? info.subscriptionType;
      } catch {
        // accountInfo() may fail on older CLI versions — degrade gracefully.
      }

      this.cache = {
        ...(account !== undefined && account !== '' && { account }),
        ...(currentModel !== undefined && currentModel !== '' && { model: currentModel }),
        ...(currentPermissionMode !== undefined &&
          currentPermissionMode !== '' && { permissionMode: currentPermissionMode }),
      };
      this.fetchedAt = Date.now();
      return this.cache;
    } finally {
      try {
        if (typeof q.return === 'function') {
          await q.return();
        } else if (typeof q.close === 'function') {
          q.close();
        }
      } catch {
        /* ignore */
      }
    }
  }

  invalidate(): void {
    this.cache = undefined;
    this.fetchedAt = 0;
  }
}
