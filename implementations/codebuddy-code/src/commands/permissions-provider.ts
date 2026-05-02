/**
 * Codebuddy-specific `PermissionsProvider` — fetches permission modes
 * from the Tencent Agent SDK via a short-lived `createSession()`.
 *
 * Uses `session.getAvailableModes()` (experimental, requires CLI support
 * for `get_available_modes`). Cached for 5 minutes.
 */
import {
  unstable_v2_createSession as createSession,
  type Options,
} from '@tencent-ai/agent-sdk';
import type { PermissionModeInfo, PermissionsProvider } from 'shepaw-acp-sdk';

export interface CodeBuddyPermissionsProviderOptions {
  cwd: string;
  environment?: Options['environment'];
  endpoint?: string;
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class CodeBuddyPermissionsProvider implements PermissionsProvider {
  private cache: PermissionModeInfo[] = [];
  private fetchedAt = 0;
  private readonly ttlMs: number;

  constructor(private readonly opts: CodeBuddyPermissionsProviderOptions) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  }

  async modes(): Promise<PermissionModeInfo[]> {
    if (this.cache.length > 0 && Date.now() - this.fetchedAt < this.ttlMs) {
      return this.cache;
    }
    const sessionOpts: Parameters<typeof createSession>[0] = { cwd: this.opts.cwd };
    if (this.opts.environment !== undefined) sessionOpts.environment = this.opts.environment;
    if (this.opts.endpoint !== undefined) sessionOpts.endpoint = this.opts.endpoint;

    const session = createSession(sessionOpts);
    try {
      await session.connect();
      const raw = await session.getAvailableModes();
      this.cache = raw.map((m) => ({ id: m.id, name: m.name, description: m.description }));
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
    this.cache = [];
    this.fetchedAt = 0;
  }
}
