/**
 * Shared helpers for reading engine transcript stores off disk.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import type { SessionHistoryMessage } from 'shepaw-acp-sdk';

import { formatToolLines } from '../permission/format.js';

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

/** One transcript entry's contribution to a turn (pre-merge). */
export interface TurnDraft {
  role: 'user' | 'agent';
  /** Answer text (empty when the entry carried only progress). */
  content: string;
  /** Progress-section text: thinking / tool calls / plan. */
  progress?: string;
  /** Title of the last progress section (mirrors the live bubble). */
  progressTitle?: string;
  /** auto_collapse of the last progress section (default true). */
  progressAutoCollapse?: boolean;
  createdAt?: string;
  messageId?: string;
}

export function pushTurn(out: DiskHistoryMessage[], draft: TurnDraft): void {
  const text = draft.content.trim();
  const progress = draft.progress?.trim() ?? '';
  if (text.length === 0 && progress.length === 0) return;
  const last = out[out.length - 1];
  if (last !== undefined && last.role === draft.role) {
    // One logical reply spans many transcript entries (text segments split by
    // tool calls; tool_result rows extract to '' and contribute progress only).
    // Coalesce them — the app renders each history message as its own bubble,
    // and an unmerged list makes a single streamed reply reappear as several
    // bubbles. Answer segments and progress segments merge independently.
    if (text.length > 0) {
      last.content = last.content.length > 0 ? `${last.content}\n\n${text}` : text;
    }
    if (progress.length > 0) {
      last.progress_content =
        last.progress_content !== undefined && last.progress_content.length > 0
          ? `${last.progress_content}\n${progress}`
          : progress;
      // Last titled section wins, mirroring the live stream's section title.
      if (draft.progressTitle !== undefined) last.progress_title = draft.progressTitle;
      if (draft.progressAutoCollapse !== undefined) {
        last.progress_auto_collapse = draft.progressAutoCollapse;
      }
    }
    // Keep the FIRST segment's timestamp/message_id: it matches the live
    // bubble's send time; backfill when the first segment lacked them.
    if (last.created_at === undefined && draft.createdAt !== undefined) {
      last.created_at = draft.createdAt;
    }
    if (last.message_id === undefined && draft.messageId !== undefined && draft.messageId.length > 0) {
      last.message_id = draft.messageId;
    }
    return;
  }
  const msg: DiskHistoryMessage = { role: draft.role, content: text };
  if (progress.length > 0) {
    msg.progress_content = progress;
    if (draft.progressTitle !== undefined) msg.progress_title = draft.progressTitle;
    msg.progress_auto_collapse = draft.progressAutoCollapse ?? true;
  }
  if (draft.createdAt !== undefined) msg.created_at = draft.createdAt;
  if (draft.messageId !== undefined && draft.messageId.length > 0) msg.message_id = draft.messageId;
  out.push(msg);
}

/**
 * Split Anthropic-style content blocks (Claude Code, CodeBuddy) into answer
 * text vs progress text. `thinking` → progress ('Thinking'); `tool_use` →
 * `[completed] name` + command/files (same shape as the live stream).
 */
export function splitAnthropicBlocks(content: unknown): {
  answer: string;
  progress: string;
  progressTitle?: string;
} {
  if (!Array.isArray(content)) {
    return { answer: typeof content === 'string' ? content : '', progress: '' };
  }
  const answers: string[] = [];
  const progressParts: string[] = [];
  let progressTitle: string | undefined;
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' || b.type === 'input_text' || b.type === 'output_text') {
      if (typeof b.text === 'string' && b.text.trim().length > 0) answers.push(b.text);
      continue;
    }
    if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim().length > 0) {
      progressParts.push(b.thinking.trim());
      progressTitle = 'Thinking';
      continue;
    }
    if (b.type === 'tool_use') {
      const name = typeof b.name === 'string' && b.name.length > 0 ? b.name : 'Tool';
      const input = (b.input ?? {}) as Record<string, unknown>;
      const command = typeof input.command === 'string' ? input.command : undefined;
      const paths: string[] = [];
      for (const key of ['file_path', 'path', 'notebook_path']) {
        const v = input[key];
        if (typeof v === 'string' && v.length > 0) paths.push(v);
      }
      progressParts.push(formatToolLines('completed', name, command, paths).trimEnd());
      progressTitle = name;
    }
  }
  return {
    answer: answers.join('\n').trim(),
    progress: progressParts.join('\n'),
    progressTitle,
  };
}
