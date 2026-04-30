/**
 * Persist the "pending tool-use approval" state for the async-confirmation
 * flow across gateway restarts.
 *
 * Context: in the async-confirmation model, when a CodeBuddy Agent SDK turn
 * requests a tool we can't auto-approve, `canUseTool` emits a
 * `ui.actionConfirmation` to the phone and immediately returns `deny` to
 * unblock the SDK turn (the turn ends right after, so the app stops seeing
 * a "loading..." spinner). The user then taps Allow/Deny (or types
 * "allow"/"deny") in a NEW chat message, at which point we need to remember:
 *
 *   1. There was a pending approval for this session.
 *   2. Which tool + what input the model was asking about — so that when we
 *      re-run the SDK via `--resume`, the `approvalCache` can short-circuit
 *      `canUseTool` and the tool actually executes.
 *
 * Persisting to disk matters for two reasons:
 *   - The gateway process might be restarted between the user seeing the
 *     confirmation and tapping Allow (crash, redeploy, reboot).
 *   - Without persistence the `--resume` path is useless for anything the
 *     SDK thinks is "pending" — the SDK itself doesn't record approval
 *     state, it just replays history.
 *
 * Storage: `~/.config/shepaw-cc-gateway/pending-approvals.json`, keyed by
 * Shepaw sessionId. At most one pending marker per session at any time —
 * the SDK only allows one tool_use in flight per turn.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import { log } from './debug.js';

const DEFAULT_PATH = join(homedir(), '.config', 'shepaw-cc-gateway', 'pending-approvals.json');

export interface PendingMarkerOptions {
  /** Override the persistence path. Default `~/.config/shepaw-cc-gateway/pending-approvals.json`. */
  path?: string;
}

/** What the user is being asked to approve. */
export interface PendingMarker {
  /** The tool the SDK was about to invoke (e.g. "Bash"). */
  readonly toolName: string;
  /** The tool input snapshot. Used by ApprovalCache lookup in the resume turn. */
  readonly input: Record<string, unknown>;
  /** The `confirmation_id` we sent to the phone — lets the in-band submitResponse path resolve us. */
  readonly cid: string;
  /** Wall-clock when the confirmation was first sent. For debug/telemetry only. */
  readonly requestedAtMs: number;
  /** Display prompt we sent the user, stored for approvalCache mirroring. */
  readonly displayPrompt: string;
}

interface PersistedShape {
  version: 1;
  /** Shepaw sessionId → PendingMarker */
  map: Record<string, PendingMarker>;
}

export class PendingMarkerStore {
  private readonly path: string;
  private readonly markers = new Map<string, PendingMarker>();
  private writeTimer: NodeJS.Timeout | undefined;

  constructor(opts: PendingMarkerOptions = {}) {
    this.path = opts.path ?? DEFAULT_PATH;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, 'utf-8');
      const data = JSON.parse(raw) as PersistedShape;
      if (data.version === 1 && data.map && typeof data.map === 'object') {
        for (const [sessionId, marker] of Object.entries(data.map)) {
          if (this.isValidMarker(marker)) {
            this.markers.set(sessionId, marker);
          }
        }
        log.gateway(
          'PendingMarkerStore loaded %d entries from %s',
          this.markers.size,
          this.path,
        );
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        log.gateway(
          'PendingMarkerStore: no existing file at %s (fresh start)',
          this.path,
        );
      } else {
        log.gateway('PendingMarkerStore load failed: %s', e.message);
      }
    }
  }

  get(sessionId: string): PendingMarker | undefined {
    return this.markers.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.markers.has(sessionId);
  }

  set(sessionId: string, marker: PendingMarker): void {
    this.markers.set(sessionId, marker);
    this.schedulePersist();
  }

  /** Remove the marker for a session. No-op if none exists. */
  delete(sessionId: string): void {
    if (this.markers.delete(sessionId)) {
      this.schedulePersist();
    }
  }

  async flush(): Promise<void> {
    if (this.writeTimer !== undefined) {
      clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
    }
    await this.persistNow();
  }

  private schedulePersist(): void {
    if (this.writeTimer !== undefined) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined;
      void this.persistNow().catch((err) =>
        log.gateway('PendingMarkerStore persist failed: %s', String(err)),
      );
    }, 200);
  }

  private async persistNow(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const data: PersistedShape = {
      version: 1,
      map: Object.fromEntries(this.markers),
    };
    await writeFile(this.path, JSON.stringify(data, null, 2), 'utf-8');
  }

  private isValidMarker(obj: unknown): obj is PendingMarker {
    if (typeof obj !== 'object' || obj === null) return false;
    const m = obj as Partial<PendingMarker>;
    return (
      typeof m.toolName === 'string' &&
      typeof m.cid === 'string' &&
      typeof m.requestedAtMs === 'number' &&
      typeof m.displayPrompt === 'string' &&
      typeof m.input === 'object' &&
      m.input !== null
    );
  }
}
