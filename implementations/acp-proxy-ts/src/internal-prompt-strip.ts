/**
 * Strip Hub-injected prompt sections before transcript export / history sync.
 *
 * Aligned with shepaw `SessionUtils.stripHubInternalPromptForDisplay`.
 */

import type {
  SessionHistoryMessage,
  SessionHistoryMessageKind,
  SessionHistoryMetadata,
} from 'shepaw-acp-sdk';

import { SCOPE_CARD_STABLE_HEADER } from './store-pouch-card.js';

/** Volatile per-turn scope section (shepaw ScopeCard.toVolatileMarkdown). */
export const SCOPE_CARD_VOLATILE_HEADER = `${SCOPE_CARD_STABLE_HEADER} · 本轮`;

/** Group-task roster block (see group-context.ts). */
export const GROUP_TASK_CONTEXT_HEADER = '## 群任务上下文';

/** Section headers injected into upstream prompts but not user-visible chat. */
export const INTERNAL_PROMPT_SECTION_HEADERS = [
  SCOPE_CARD_STABLE_HEADER,
  GROUP_TASK_CONTEXT_HEADER,
] as const;

/** Last stable Scope Card bullet; user text may be glued when blocks are joined. */
const SCOPE_CARD_LAST_BULLET =
  '- 未指定分区时：长期文件 → `files`；本轮中间产物 → `runtime`';

type StripMode = 'normal' | 'scope' | 'group';

function isInternalSectionHeader(line: string): boolean {
  return INTERNAL_PROMPT_SECTION_HEADERS.some((h) => line.startsWith(h));
}

function isGroupContextBodyLine(line: string): boolean {
  const t = line.trim();
  if (t.length === 0) return false;
  if (t.startsWith('- ')) return true;
  if (t.startsWith('群')) return true;
  if (t.startsWith('成员')) return true;
  if (t.startsWith('你是本群')) return true;
  if (t.startsWith('交付约束')) return true;
  return false;
}

function peelGluedUserSuffix(line: string): string | undefined {
  if (!line.startsWith(SCOPE_CARD_LAST_BULLET)) return undefined;
  const suffix = line.slice(SCOPE_CARD_LAST_BULLET.length).trim();
  return suffix.length > 0 ? suffix : undefined;
}

/**
 * Remove Scope Card / group-context blocks; return user-visible text or ''.
 */
export function stripInternalPromptForTranscript(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  let mode: StripMode = 'normal';

  for (const line of lines) {
    if (mode === 'normal' && isInternalSectionHeader(line)) {
      mode = line.startsWith(GROUP_TASK_CONTEXT_HEADER) ? 'group' : 'scope';
      continue;
    }

    if (mode === 'scope') {
      if (isInternalSectionHeader(line)) {
        mode = line.startsWith(GROUP_TASK_CONTEXT_HEADER) ? 'group' : 'scope';
        continue;
      }
      if (line.trim().length === 0) continue;
      if (line.startsWith('- ')) {
        const glued = peelGluedUserSuffix(line);
        if (glued !== undefined) {
          mode = 'normal';
          kept.push(glued);
        }
        continue;
      }
      if (line.startsWith('## ')) {
        mode = 'normal';
        kept.push(line);
        continue;
      }
      mode = 'normal';
      kept.push(line);
      continue;
    }

    if (mode === 'group') {
      if (isInternalSectionHeader(line)) {
        mode = line.startsWith(GROUP_TASK_CONTEXT_HEADER) ? 'group' : 'scope';
        continue;
      }
      if (line.trim().length === 0 || isGroupContextBodyLine(line)) continue;
      mode = 'normal';
      kept.push(line);
      continue;
    }

    kept.push(line);
  }

  return kept.join('\n').trim();
}

/** True when [text] is only internal prompt sections (no user-visible body). */
export function isInternalPromptOnly(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  return stripInternalPromptForTranscript(t).length === 0;
}

type TextBlock = { type?: string; text?: string };

/**
 * Flatten prompt blocks for transcript: drop internal-only blocks and strip
 * bundled sections from mixed blocks (Scope Card is its own prepended block).
 */
export function promptToTranscriptUserText(
  prompt: string | TextBlock | ReadonlyArray<TextBlock>,
): string {
  if (typeof prompt === 'string') {
    return stripInternalPromptForTranscript(prompt);
  }
  const blocks = Array.isArray(prompt) ? prompt : [prompt];
  const parts: string[] = [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object' || b.type !== 'text') continue;
    const visible = stripInternalPromptForTranscript(String(b.text ?? ''));
    if (visible.length > 0) parts.push(visible);
  }
  return parts.join('\n\n').trim();
}

/** Classify a synthetic user turn for protocol `metadata.kind`. */
export function classifyInternalPromptKind(text: string): SessionHistoryMessageKind | undefined {
  const t = text.trim();
  if (t.startsWith(SCOPE_CARD_VOLATILE_HEADER)) return 'scope_card_volatile';
  if (t.startsWith(SCOPE_CARD_STABLE_HEADER)) return 'scope_card_stable';
  if (t.startsWith(GROUP_TASK_CONTEXT_HEADER)) return 'group_task_context';
  return undefined;
}

/** Hub history metadata for UI-only internal prompt rows. */
export function internalPromptHistoryMetadata(text: string): SessionHistoryMetadata {
  return {
    ui_hidden: true,
    history_exclude: true,
    kind: classifyInternalPromptKind(text) ?? 'scope_card_stable',
  };
}

function mergeHistoryMetadata(
  existing: SessionHistoryMetadata | undefined,
  extra: SessionHistoryMetadata,
): SessionHistoryMetadata {
  return { ...existing, ...extra };
}

/** Sanitize history messages before session/history sync to the App. */
export function sanitizeSessionHistoryMessages(
  messages: ReadonlyArray<SessionHistoryMessage>,
): SessionHistoryMessage[] {
  const out: SessionHistoryMessage[] = [];
  for (const m of messages) {
    if (m.role !== 'user') {
      out.push(m);
      continue;
    }
    const visible = stripInternalPromptForTranscript(m.content);
    if (visible.length === 0) {
      if (!isInternalPromptOnly(m.content)) continue;
      out.push({
        ...m,
        metadata: mergeHistoryMetadata(m.metadata, internalPromptHistoryMetadata(m.content)),
      });
      continue;
    }
    if (visible === m.content) {
      out.push(m);
      continue;
    }
    out.push({ ...m, content: visible });
  }
  return out;
}
