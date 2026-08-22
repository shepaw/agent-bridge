/**
 * Gateway-side transcript bypass (SESSION_HISTORY_DESIGN P3).
 *
 * Buffers per-session NDJSON turns and debounced-writes them into the
 * Nexuspouch `sessions` space via StoreToolsClient HTTP.
 *
 * Enable when NEXUSPOUCH_URL (or default loopback) + NEXUSPOUCH_DEVICE + token
 * are set. Disable with NEXUSPOUCH_TRANSCRIPT=off.
 *
 * Path: store://sessions/<device>/<agent>/<session_id>.jsonl
 */

import { StoreToolsClient } from './store-tools.js';
import { resolveHubStoreBase } from './hub-store-env.js';
import { log } from './debug.js';

export type TranscriptRole = 'user' | 'assistant' | 'tool';

export interface TranscriptLine {
  agent: string;
  session_id: string;
  seq: number;
  ts_ms: number;
  role: TranscriptRole;
  content: string;
}

interface SessionBuf {
  lines: TranscriptLine[];
  seq: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  flushing: boolean;
  dirty: boolean;
}

export interface SessionTranscriptSinkOptions {
  client: StoreToolsClient;
  agent: string;
  debounceMs?: number;
  /** Injected clock for tests. */
  now?: () => number;
}

export class SessionTranscriptSink {
  private readonly client: StoreToolsClient;
  private readonly agent: string;
  private readonly debounceMs: number;
  private readonly now: () => number;
  private readonly buffers = new Map<string, SessionBuf>();

  constructor(opts: SessionTranscriptSinkOptions) {
    this.client = opts.client;
    this.agent = sanitizeAgent(opts.agent);
    this.debounceMs = opts.debounceMs ?? 5_000;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Build from env; returns null when capture is disabled / misconfigured. */
  static fromEnv(
    env: NodeJS.ProcessEnv = process.env,
    agentName: string,
  ): SessionTranscriptSink | null {
    const flag = (env.NEXUSPOUCH_TRANSCRIPT ?? '').trim().toLowerCase();
    if (flag === '0' || flag === 'false' || flag === 'off') return null;

    const hubBase = resolveHubStoreBase(env);
    const device = (
      env.NEXUSPOUCH_DEVICE ??
      env.SHEPAW_HUB_STORE_DEVICE ??
      ''
    ).trim();
    const token = (
      env.NEXUSPOUCH_ADMIN_TOKEN ??
      env.NEXUSPOUCH_TOKEN ??
      env.SHEPAW_HUB_STORE_TOKEN ??
      (hubBase ? 'local' : '')
    ).trim();
    // Prefer explicit Nexuspouch URL; else hub peer store HTTP; else ROOT default.
    const url =
      (env.NEXUSPOUCH_URL ?? '').trim() ||
      hubBase ||
      ((env.NEXUSPOUCH_ROOT || env.NEXUSPOUCH_MCP_ROOT)
        ? 'http://127.0.0.1:8787'
        : '');
    if (!url || !device) {
      if (env.NEXUSPOUCH_TRANSCRIPT === '1' || env.NEXUSPOUCH_TRANSCRIPT === 'true') {
        log(
          'transcript sink requested but missing store URL/DEVICE; disabled',
        );
      }
      return null;
    }
    if (!token && !hubBase) {
      if (env.NEXUSPOUCH_TRANSCRIPT === '1' || env.NEXUSPOUCH_TRANSCRIPT === 'true') {
        log('transcript sink requested but missing TOKEN; disabled');
      }
      return null;
    }

    const debounce = Number(env.NEXUSPOUCH_TRANSCRIPT_DEBOUNCE_MS ?? '5000');
    return new SessionTranscriptSink({
      client: new StoreToolsClient(url.replace(/\/$/, ''), token || 'local', device),
      agent: agentName,
      debounceMs: Number.isFinite(debounce) && debounce >= 0 ? debounce : 5_000,
    });
  }

  append(sessionId: string, role: TranscriptRole, content: string): void {
    const text = content.trim();
    if (!text) return;
    const id = sanitizeSessionId(sessionId);
    let buf = this.buffers.get(id);
    if (buf === undefined) {
      buf = { lines: [], seq: 0, timer: undefined, flushing: false, dirty: false };
      this.buffers.set(id, buf);
    }
    buf.seq += 1;
    buf.lines.push({
      agent: this.agent,
      session_id: id,
      seq: buf.seq,
      ts_ms: this.now(),
      role,
      content: text,
    });
    buf.dirty = true;
    this.schedule(id);
  }

  /** Flush immediately (tests / shutdown). */
  async flush(sessionId: string): Promise<void> {
    const id = sanitizeSessionId(sessionId);
    const buf = this.buffers.get(id);
    if (buf?.timer !== undefined) {
      clearTimeout(buf.timer);
      buf.timer = undefined;
    }
    await this.flushNow(id);
  }

  async flushAll(): Promise<void> {
    const ids = [...this.buffers.keys()];
    await Promise.all(ids.map((id) => this.flush(id)));
  }

  /** Exposed for unit tests. */
  pendingLines(sessionId: string): TranscriptLine[] {
    return [...(this.buffers.get(sanitizeSessionId(sessionId))?.lines ?? [])];
  }

  private schedule(sessionId: string): void {
    const buf = this.buffers.get(sessionId);
    if (buf === undefined) return;
    // debounceMs=0: coalesce until explicit flush() (tests / stop-of-turn).
    if (this.debounceMs === 0) return;
    if (buf.timer !== undefined) clearTimeout(buf.timer);
    buf.timer = setTimeout(() => {
      buf.timer = undefined;
      void this.flushNow(sessionId);
    }, this.debounceMs);
  }

  private async flushNow(sessionId: string): Promise<void> {
    const buf = this.buffers.get(sessionId);
    if (buf === undefined || !buf.dirty) return;
    while (buf.flushing) {
      await new Promise((r) => setTimeout(r, 5));
    }
    if (!buf.dirty) return;
    buf.flushing = true;
    buf.dirty = false;
    const snapshot = buf.lines.slice();
    const body = snapshot.map((l) => JSON.stringify(l)).join('\n') + '\n';
    const filename = `${this.agent}/${sessionId}.jsonl`;
    try {
      const out = await this.client.write({
        space: 'sessions',
        filename,
        content: body,
      });
      if (!out.ok) {
        buf.dirty = true;
        log(
          'transcript flush failed for %s: %s',
          sessionId,
          out.error ?? out.code ?? 'unknown',
        );
      } else {
        log('transcript flushed %s (%d lines)', filename, snapshot.length);
      }
    } catch (err) {
      buf.dirty = true;
      log(
        'transcript flush error for %s: %s',
        sessionId,
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      buf.flushing = false;
      if (buf.dirty) this.schedule(sessionId);
    }
  }
}

export function promptToPlainText(
  prompt: string | { type?: string; text?: string } | ReadonlyArray<{ type?: string; text?: string }>,
): string {
  if (typeof prompt === 'string') return prompt;
  if (Array.isArray(prompt)) {
    return prompt
      .map((b) => (b && typeof b === 'object' && b.type === 'text' ? String(b.text ?? '') : ''))
      .join('');
  }
  if (
    prompt &&
    typeof prompt === 'object' &&
    !Array.isArray(prompt) &&
    'type' in prompt &&
    prompt.type === 'text'
  ) {
    return String(prompt.text ?? '');
  }
  return '';
}

function sanitizeAgent(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'agent';
}

function sanitizeSessionId(id: string): string {
  const s = id.trim().replace(/[^a-zA-Z0-9._-]+/g, '_');
  return s.slice(0, 120) || 'session';
}
