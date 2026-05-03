/**
 * CodeBuddy-specific `StatusProvider` — reads the current account summary
 * via a short-lived `createSession()`.
 *
 * `getPermissionMode()` and `getModel()` are available synchronously after
 * `connect()`, so we reuse the same zero-prompt warmup pattern used by
 * `CodeBuddyModelsProvider` — no LLM turn is consumed.
 *
 * `account` is not directly exposed by the Tencent SDK session API at this
 * time; we leave it undefined and fall back to cfg fields so the handler
 * still shows `model` and `permissionMode`.
 *
 * Cached for 5 minutes (same TTL as models/permissions providers).
 */
import {
  unstable_v2_createSession as createSession,
  type Options,
} from '@tencent-ai/agent-sdk';
import type { StatusProvider, StatusSummary } from 'shepaw-acp-sdk';

export interface CodeBuddyStatusProviderOptions {
  cwd: string;
  environment?: Options['environment'];
  endpoint?: string;
  /** Currently-selected model — forwarded to session init. */
  getCurrentModel?(): string | undefined;
  /** Current permission mode from cfg — forwarded to session init. */
  getCurrentPermissionMode?(): string | undefined;
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class CodeBuddyStatusProvider implements StatusProvider {
  private cache: StatusSummary | undefined;
  private fetchedAt = 0;
  private readonly ttlMs: number;

  constructor(private readonly opts: CodeBuddyStatusProviderOptions) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  }

  async summary(): Promise<StatusSummary> {
    if (this.cache !== undefined && Date.now() - this.fetchedAt < this.ttlMs) {
      return this.cache;
    }

    const sessionOpts: Parameters<typeof createSession>[0] = { cwd: this.opts.cwd };
    const currentModel = this.opts.getCurrentModel?.();
    const currentMode = this.opts.getCurrentPermissionMode?.();
    if (currentModel !== undefined) sessionOpts.model = currentModel;
    if (this.opts.environment !== undefined) sessionOpts.environment = this.opts.environment;
    if (this.opts.endpoint !== undefined) sessionOpts.endpoint = this.opts.endpoint;

    const session = createSession(sessionOpts);
    try {
      await session.connect();

      const model = session.getModel() ?? currentModel;
      // `getPermissionMode()` returns the live value from the CLI process;
      // fall back to what the caller told us if it comes back undefined/empty.
      const rawMode = session.getPermissionMode() as string | undefined;
      const permissionMode =
        rawMode !== undefined && rawMode !== '' ? rawMode : currentMode;

      this.cache = {
        // account: not exposed by Tencent SDK session — left undefined
        ...(model !== undefined && model !== '' && { model }),
        ...(permissionMode !== undefined && permissionMode !== '' && { permissionMode }),
      };
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

  invalidate(): void {
    this.cache = undefined;
    this.fetchedAt = 0;
  }
}
