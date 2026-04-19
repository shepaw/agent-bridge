/**
 * Per-session conversation history manager.
 *
 * Wire-compatible with `shepaw_acp_sdk.conversation.ConversationManager`:
 *   - Per-session `messages[]` with automatic trimming to `maxHistory` turns
 *     (each turn = 2 messages: user + assistant, so cap is `maxHistory * 2`).
 *   - Per-session last-access timestamp for TTL-based cleanup.
 *   - `rollback()` removes the trailing assistant + user pair (if present).
 */

import type { ConversationMessage } from './types.js';

export interface ConversationManagerOptions {
  /** Maximum number of turns (user+assistant pairs) to keep per session. Default 20. */
  maxHistory?: number;
}

export class ConversationManager {
  readonly maxHistory: number;

  private readonly sessions = new Map<string, ConversationMessage[]>();
  private readonly lastAccess = new Map<string, number>();

  constructor(opts: ConversationManagerOptions = {}) {
    this.maxHistory = opts.maxHistory ?? 20;
  }

  /** Return the message list for a session (empty array if it doesn't exist). */
  getMessages(sessionId: string): ConversationMessage[] {
    this.touch(sessionId);
    return this.sessions.get(sessionId) ?? [];
  }

  addUserMessage(sessionId: string, content: string): void {
    this.ensureSession(sessionId);
    this.sessions.get(sessionId)!.push({ role: 'user', content });
    this.trim(sessionId);
  }

  addAssistantMessage(sessionId: string, content: string): void {
    this.ensureSession(sessionId);
    this.sessions.get(sessionId)!.push({ role: 'assistant', content });
    this.trim(sessionId);
  }

  /**
   * Remove the last assistant+user pair.
   * Returns `true` when at least one message was removed.
   */
  rollback(sessionId: string): boolean {
    const msgs = this.sessions.get(sessionId);
    if (!msgs || msgs.length === 0) return false;
    if (msgs.at(-1)?.role === 'assistant') msgs.pop();
    if (msgs.at(-1)?.role === 'user') msgs.pop();
    return true;
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Pre-load a session with existing history. No-op if the session already exists. */
  initializeSession(sessionId: string, history: ConversationMessage[]): void {
    if (this.sessions.has(sessionId)) return;
    this.sessions.set(sessionId, [...history]);
    this.touch(sessionId);
  }

  /** Prepend older history to an existing session's message list. */
  prependHistory(sessionId: string, olderMessages: ConversationMessage[]): void {
    const existing = this.sessions.get(sessionId);
    if (!existing) return;
    this.sessions.set(sessionId, [...olderMessages, ...existing]);
    this.touch(sessionId);
  }

  /**
   * Remove sessions that have not been accessed for `maxAgeSeconds`.
   * Default: 72 hours, matching the Python SDK.
   */
  cleanupExpired(maxAgeSeconds = 72 * 3600): void {
    const now = Date.now() / 1000;
    for (const [sid, ts] of this.lastAccess.entries()) {
      if (now - ts > maxAgeSeconds) {
        this.sessions.delete(sid);
        this.lastAccess.delete(sid);
      }
    }
  }

  // ── internal ─────────────────────────────────────────────────

  private ensureSession(sessionId: string): void {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, []);
    }
    this.touch(sessionId);
  }

  private touch(sessionId: string): void {
    this.lastAccess.set(sessionId, Date.now() / 1000);
  }

  private trim(sessionId: string): void {
    const msgs = this.sessions.get(sessionId);
    if (!msgs) return;
    const cap = this.maxHistory * 2;
    if (msgs.length > cap) {
      this.sessions.set(sessionId, msgs.slice(-cap));
    }
  }
}
