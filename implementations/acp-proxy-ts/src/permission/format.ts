/**
 * Turn an ACP `session/requestPermission` tool call into a rich, human-
 * reviewable confirmation.
 *
 * The Shepaw app's `ui.actionConfirmation` component only renders `prompt`
 * (plus the action buttons) — the raw command / diff / file paths are NOT
 * surfaced by the normal tool-call stream (see session-mapper). So the
 * *prompt itself* must carry enough context for a remote reviewer to make an
 * informed allow/deny decision without losing sight of what is happening.
 */

import type * as acp from '@agentclientprotocol/sdk';

import type { UIActionOption } from 'shepaw-acp-sdk';

/** Cap embedded text so a single confirmation frame stays well under limits. */
const MAX_COMMAND_CHARS = 2000;
const MAX_DIFF_CHARS = 1500;
const MAX_CONTENT_CHARS = 1200;

/** Human labels for ACP tool kinds (also drives the leading icon). */
const KIND_LABEL: Record<string, string> = {
  read: 'read files',
  edit: 'edit files',
  delete: 'delete files',
  move: 'move/rename files',
  search: 'search',
  execute: 'run a command',
  think: 'think',
  fetch: 'fetch from the network',
  switch_mode: 'switch mode',
  other: 'run a tool',
};

const KIND_ICON: Record<string, string> = {
  read: '📖',
  edit: '✏️',
  delete: '🗑️',
  move: '📦',
  search: '🔎',
  execute: '⚡',
  think: '💭',
  fetch: '🌐',
  switch_mode: '🔀',
  other: '🔧',
};

/** ACP tool kinds that are inherently side-effecting / higher risk. */
export const RISKY_KINDS = new Set(['execute', 'delete', 'move', 'edit', 'fetch']);

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (truncated ${text.length - max} chars)`;
}

/**
 * Best-effort extraction of the "command" a tool wants to run, used both for
 * display and for policy pattern matching. Handles the common `rawInput`
 * shapes across Claude Code / Codex / CodeBuddy (command/cmd/script as string
 * or argv array), falling back to the tool title.
 */
export function extractCommand(toolCall: acp.ToolCallUpdate): string {
  const raw = toolCall.rawInput;
  if (raw !== null && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    for (const key of ['command', 'cmd', 'script', 'shell']) {
      const v = obj[key];
      if (typeof v === 'string' && v.trim().length > 0) return v.trim();
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
        return (v as string[]).join(' ').trim();
      }
    }
  }
  return (toolCall.title ?? '').trim();
}

/** Collect affected file paths from `locations` and diff/rawInput hints. */
export function extractPaths(toolCall: acp.ToolCallUpdate): string[] {
  const paths = new Set<string>();
  for (const loc of toolCall.locations ?? []) {
    if (loc?.path) paths.add(loc.path);
  }
  for (const c of toolCall.content ?? []) {
    if (c?.type === 'diff' && typeof (c as acp.Diff & { path?: string }).path === 'string') {
      paths.add((c as acp.Diff & { path: string }).path);
    }
  }
  const raw = toolCall.rawInput;
  if (raw !== null && typeof raw === 'object') {
    const p = (raw as Record<string, unknown>).path ?? (raw as Record<string, unknown>).file_path;
    if (typeof p === 'string' && p.length > 0) paths.add(p);
  }
  return [...paths];
}

function summarizeContent(toolCall: acp.ToolCallUpdate): string | undefined {
  const parts: string[] = [];
  for (const c of toolCall.content ?? []) {
    if (c?.type === 'diff') {
      const diff = c as acp.Diff & { type: 'diff' };
      const body = renderDiff(diff.path, diff.oldText ?? undefined, diff.newText);
      parts.push(truncate(body, MAX_DIFF_CHARS));
    } else if (c?.type === 'content') {
      const inner = (c as { content?: { type?: string; text?: string } }).content;
      if (inner?.type === 'text' && typeof inner.text === 'string' && inner.text.length > 0) {
        parts.push(truncate(inner.text, MAX_CONTENT_CHARS));
      }
    }
  }
  if (parts.length === 0) return undefined;
  return parts.join('\n\n');
}

function renderDiff(path: string, oldText: string | undefined, newText: string): string {
  const header = oldText === undefined ? `New file: ${path}` : `Modify: ${path}`;
  const oldLines = (oldText ?? '').split('\n').map((l) => `- ${l}`);
  const newLines = newText.split('\n').map((l) => `+ ${l}`);
  const bodyLines = oldText === undefined ? newLines : [...oldLines, ...newLines];
  return `${header}\n\`\`\`diff\n${bodyLines.join('\n')}\n\`\`\``;
}

/**
 * Build the confirmation prompt text. Deliberately plain-text-with-fences so
 * it reads fine whether or not the client renders markdown.
 */
export function formatPermissionPrompt(
  agentDisplayName: string,
  toolCall: acp.ToolCallUpdate,
): string {
  const kind = toolCall.kind ?? 'other';
  const icon = KIND_ICON[kind] ?? KIND_ICON.other;
  const action = KIND_LABEL[kind] ?? KIND_LABEL.other;
  const title = (toolCall.title ?? '').trim();

  const lines: string[] = [];
  lines.push(`${icon} ${agentDisplayName} wants to ${action}`);
  if (title.length > 0 && title !== action) lines.push(`\n${title}`);

  const command = extractCommand(toolCall);
  if (command.length > 0 && command !== title) {
    lines.push(`\n\`\`\`\n${truncate(command, MAX_COMMAND_CHARS)}\n\`\`\``);
  }

  const paths = extractPaths(toolCall);
  if (paths.length > 0) {
    lines.push(`\nFiles: ${paths.slice(0, 12).join(', ')}${paths.length > 12 ? ' …' : ''}`);
  }

  const content = summarizeContent(toolCall);
  if (content !== undefined) lines.push(`\n${content}`);

  return lines.join('\n');
}

/**
 * Map ACP permission options to Shepaw action buttons, assigning a `style`
 * the app can colour: reject → danger, allow-always → secondary, allow-once →
 * primary. `id`/`value` carry the ACP optionId so the reply round-trips.
 */
export function buildActions(options: ReadonlyArray<acp.PermissionOption>): UIActionOption[] {
  if (options.length === 0) {
    return [
      { id: 'allow', label: 'Allow', value: 'allow', style: 'primary' },
      { id: 'deny', label: 'Deny', value: 'deny', style: 'danger' },
    ];
  }
  return options.map((opt) => ({
    id: opt.optionId,
    value: opt.optionId,
    label: opt.name,
    style: styleForKind(opt.kind),
  }));
}

function styleForKind(kind: acp.PermissionOptionKind): 'primary' | 'secondary' | 'danger' {
  switch (kind) {
    case 'reject_once':
    case 'reject_always':
      return 'danger';
    case 'allow_always':
      return 'secondary';
    case 'allow_once':
    default:
      return 'primary';
  }
}

/**
 * Pick the ACP optionId that best expresses an auto-decision. For `allow`
 * prefer `allow_once` (least escalation), else `allow_always`. For `deny`
 * prefer `reject_once`, else `reject_always`. Returns undefined when no
 * matching option exists (caller should fall back to `cancelled`).
 */
export function pickOption(
  options: ReadonlyArray<acp.PermissionOption>,
  want: 'allow' | 'deny',
): string | undefined {
  const order: acp.PermissionOptionKind[] =
    want === 'allow' ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  for (const kind of order) {
    const found = options.find((o) => o.kind === kind);
    if (found !== undefined) return found.optionId;
  }
  // Name-based fallback for agents that don't set `kind` correctly.
  const rx = want === 'allow' ? /allow|yes|approve|accept/i : /deny|no|reject|decline/i;
  return options.find((o) => rx.test(o.name))?.optionId;
}

/** Match the app's reply back to an ACP optionId. */
export function resolveSelectedOption(
  options: ReadonlyArray<acp.PermissionOption>,
  response: Record<string, unknown>,
): string | undefined {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  // The Shepaw app sends `selected_action_id` (= our optionId) and
  // `selected_action_label` (= the option name). Older/alt shapes fall back to
  // action/value/selected.
  const raw =
    str(response.selected_action_id) ||
    str(response.action) ||
    str(response.value) ||
    str(response.selected) ||
    str(response.selected_action_label) ||
    '';
  if (raw.length === 0) return undefined;

  const exact = options.find(
    (o) => o.optionId === raw || o.name.toLowerCase() === raw.toLowerCase(),
  );
  if (exact !== undefined) return exact.optionId;

  if (/^(allow|yes|ok|approve|accept)/i.test(raw)) return pickOption(options, 'allow');
  if (/^(deny|no|reject|cancel|decline)/i.test(raw)) return pickOption(options, 'deny');
  return undefined;
}
