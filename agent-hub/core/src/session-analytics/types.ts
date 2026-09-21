/**
 * Shared vocabulary for post-hoc session analytics.
 *
 * A `TurnRecord` is one *model request* — not one chat bubble and not one
 * transcript line. Everything here is shaped by that choice: token usage is
 * only meaningful per request, because that is the granularity at which the
 * provider reports it.
 */

/** Token counters, normalized across engines. All values are non-negative. */
export interface Usage {
  /** Uncached prompt tokens. */
  input: number;
  /** Prompt tokens served from the provider's cache. */
  cacheRead: number;
  /** Prompt tokens written to the cache. */
  cacheWrite: number;
  /** Completion tokens (includes `thinking` where the provider bills it that way). */
  output: number;
  /** Reasoning/thinking tokens, when reported separately. */
  thinking: number;
}

export function emptyUsage(): Usage {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, thinking: 0 };
}

export function addUsage(into: Usage, from: Usage): void {
  into.input += from.input;
  into.cacheRead += from.cacheRead;
  into.cacheWrite += from.cacheWrite;
  into.output += from.output;
  into.thinking += from.thinking;
}

/** A tool invocation observed inside one request's response. */
export interface ToolUse {
  name: string;
  /** Source block/event type — e.g. `tool_use`, `function_call`, `local_shell_call`. */
  kind: string;
}

/** Why a record is worth distrusting. Never silently dropped — always counted. */
export type RecordFlag =
  /** `model === "<synthetic>"`: the engine's own error/placeholder turn. */
  | 'synthetic-model'
  /** No usage object on the transcript line at all. */
  | 'missing-usage'
  /** No stable request id; each line had to stand alone, so usage may repeat. */
  | 'no-request-id'
  /** A codex session that rewound (`thread_rolled_back` / `turn_aborted`). */
  | 'rollback';

export interface TurnRecord {
  /** Engine id, e.g. `claude-code` / `codex`. */
  engine: string;
  sessionId: string;
  /** Sub-agent transcript id, when this turn came from `subagents/agent-*.jsonl`. */
  agentId?: string;
  /** True for sub-agent (`isSidechain`) traffic. */
  sidechain: boolean;
  /** Claude Code project slug — the workspace identity shared across engines. */
  workspaceSlug: string;
  /** Absolute cwd when the transcript records one. */
  workspaceCwd?: string;
  model: string;
  /** ISO timestamp of the request's first line. */
  ts?: string;
  /** Dedupe key: `message.id` for claude-code; a per-turn key for codex. */
  requestId: string;
  usage: Usage;
  tools: ToolUse[];
  /** Transcript lines that collapsed into this one request (streaming block-per-line). */
  lines: number;
  flags: RecordFlag[];
}

/** Filters applied while scanning. Unset fields match everything. */
export interface AnalyzeFilters {
  session?: string;
  workspace?: string;
  /** Registered instance id — resolved to its cwd, then to a workspace slug. */
  instance?: string;
  engine?: string;
  /** Inclusive lower bound (ISO 8601). */
  since?: string;
  /** Exclusive upper bound (ISO 8601). */
  until?: string;
}

/** Where to look for transcripts. Overridable so tests can use fixtures. */
export interface ScanRoots {
  claudeProjectsDir: string;
  codexSessionsDir: string;
}

export interface ScanStats {
  filesScanned: number;
  filesSkipped: number;
  /** Transcript lines that carried usage, before dedupe. */
  linesWithUsage: number;
  /** Distinct requests after dedupe. */
  requests: number;
  /** `linesWithUsage / requests` — the streaming inflation factor. */
  collapseRatio: number;
}

export interface ScanResult {
  records: TurnRecord[];
  stats: ScanStats;
  /** Non-fatal problems (unreadable files, malformed lines), deduped. */
  warnings: string[];
}
