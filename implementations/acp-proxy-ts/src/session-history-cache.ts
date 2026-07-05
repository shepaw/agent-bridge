import type { SessionHistoryMessage } from 'shepaw-acp-sdk';

/** In-memory transcript cache — avoids repeated cursor-agent spawns for Hub / peer reads. */
export class SessionHistoryCache {
  private readonly entries = new Map<string, { at: number; messages: SessionHistoryMessage[] }>();

  constructor(private readonly ttlMs = 60_000) {}

  get(sessionId: string): SessionHistoryMessage[] | undefined {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) return undefined;
    if (Date.now() - entry.at > this.ttlMs) {
      this.entries.delete(sessionId);
      return undefined;
    }
    return entry.messages;
  }

  set(sessionId: string, messages: SessionHistoryMessage[]): void {
    this.entries.set(sessionId, { at: Date.now(), messages });
  }

  invalidate(sessionId: string): void {
    this.entries.delete(sessionId);
  }
}
