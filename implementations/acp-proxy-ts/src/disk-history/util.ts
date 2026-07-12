/**
 * Shared helpers for reading engine transcript stores off disk.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import type { SessionHistoryMessage } from 'shepaw-acp-sdk';

export type DiskHistoryMessage = SessionHistoryMessage;

/** Encode an absolute cwd the way Claude Code does for `~/.claude/projects/`. */
export function claudeProjectSlug(cwd: string): string {
  const abs = cwd.startsWith('/') ? cwd : join(process.cwd(), cwd);
  return abs.replace(/\//g, '-');
}

/** Encode cwd the way CodeBuddy does for `~/.codebuddy/projects/` (no leading slash → dash). */
export function codebuddyProjectSlug(cwd: string): string {
  const abs = cwd.startsWith('/') ? cwd : join(process.cwd(), cwd);
  return abs.replace(/^\//, '').replace(/\//g, '-');
}

export function homePath(...parts: string[]): string {
  return join(homedir(), ...parts);
}

/** Pull plain text from Anthropic/Codex/CodeBuddy-style content blocks. */
export function textFromContentBlocks(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    const type = b.type;
    if (type === 'text' || type === 'input_text' || type === 'output_text') {
      if (typeof b.text === 'string' && b.text.trim().length > 0) parts.push(b.text);
    }
  }
  return parts.join('\n').trim();
}

export function toIsoFromUnknown(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
    return undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Heuristic: seconds vs milliseconds.
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  return undefined;
}

export function pushTurn(
  out: DiskHistoryMessage[],
  role: 'user' | 'agent',
  content: string,
  createdAt: string | undefined,
  messageId?: string,
): void {
  const text = content.trim();
  if (text.length === 0) return;
  const msg: DiskHistoryMessage = { role, content: text };
  if (createdAt !== undefined) msg.created_at = createdAt;
  if (messageId !== undefined && messageId.length > 0) msg.message_id = messageId;
  out.push(msg);
}
