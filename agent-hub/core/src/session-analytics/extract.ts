/**
 * Per-engine transcript readers → one uniform stream of `TurnRecord`s.
 *
 * Four correctness rules govern everything here. Each was established by
 * measuring the local transcript corpus, and three of them contradict the
 * naive reading of the files:
 *
 * 1. Claude Code writes ONE JSONL LINE PER CONTENT BLOCK, not one per model
 *    response. Every line of a streamed response repeats the same `message.id`
 *    plus a snapshot of that response's *cumulative* usage. So usage must be
 *    collapsed per `message.id` (raw summation inflates output ~2.5x), and the
 *    snapshot to keep is the FINAL one: early lines carry `output_tokens: 0`
 *    while the response is still streaming, so keeping the first line
 *    undercounts output by ~37%.
 *
 * 2. Content blocks must be UNIONed across the lines sharing a `message.id`,
 *    deduped by `tool_use.id`. Keeping only the first line loses ~92% of tool
 *    calls — the `tool_use` block is almost never on the first line.
 *
 * 3. Codex `total_token_usage` is cumulative and can REWIND
 *    (`thread_rolled_back` / `turn_aborted`), so per-turn figures come from
 *    `last_token_usage`. Summed deltas are the only per-turn view available,
 *    but they will not reconcile with the session's final `total_token_usage`
 *    when a rollback happened — such sessions are flagged, never silently
 *    reconciled.
 *
 * 4. The two engines disagree on what `input_tokens` means. Anthropic reports
 *    UNCACHED prompt tokens (`cache_read` is additional); Codex reports the
 *    FULL prompt with `cached_input_tokens` as a subset of it. Verified on
 *    2,396 local events: `total_tokens == input + output` and
 *    `cached_input <= input` always. We normalize to the Anthropic convention
 *    by subtracting the cached portion, otherwise Codex input is inflated and
 *    the cross-engine cache-efficiency ratio is meaningless.
 */

import { readdir, readFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

import type {
  AnalyzeFilters,
  RecordFlag,
  ScanRoots,
  ScanResult,
  ScanStats,
  ToolUse,
  TurnRecord,
  Usage,
} from './types.js';
import { emptyUsage } from './types.js';

export const CLAUDE_CODE_ENGINE = 'claude-code';
export const CODEX_ENGINE = 'codex';

/**
 * Encode an absolute cwd the way Claude Code does for `~/.claude/projects/`.
 *
 * Copied verbatim from the acp-proxy reader (`disk-history/util.ts`). It is
 * four lines and duplicated on purpose: importing it would drag the whole
 * acp-proxy workspace into the hub's dependency graph for one string join.
 */
export function claudeProjectSlug(cwd: string): string {
  const abs = cwd.startsWith('/') ? cwd : join(process.cwd(), cwd);
  return abs.replace(/\//g, '-');
}

/** Default transcript locations for this machine. */
export function defaultScanRoots(): ScanRoots {
  return {
    claudeProjectsDir: join(homedir(), '.claude', 'projects'),
    codexSessionsDir: join(homedir(), '.codex', 'sessions'),
  };
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Per-field maximum — usage within one request is cumulative, so max == final. */
function maxUsage(into: Usage, from: Usage): void {
  into.input = Math.max(into.input, from.input);
  into.cacheRead = Math.max(into.cacheRead, from.cacheRead);
  into.cacheWrite = Math.max(into.cacheWrite, from.cacheWrite);
  into.output = Math.max(into.output, from.output);
  into.thinking = Math.max(into.thinking, from.thinking);
}

function isZeroUsage(u: Usage): boolean {
  return u.input === 0 && u.cacheRead === 0 && u.cacheWrite === 0 && u.output === 0;
}

// ── claude-code ────────────────────────────────────────────────────

/** Everything accumulated for one `message.id` across its transcript lines. */
interface ClaudeRequest {
  usage: Usage;
  /** `tool_use` blocks keyed by block id — the union across this request's lines. */
  tools: Map<string, ToolUse>;
  model: string;
  firstTs?: string;
  cwd?: string;
  lines: number;
  sawUsage: boolean;
  sawStableId: boolean;
  sidechain: boolean;
  synthetic: boolean;
}

function newClaudeRequest(): ClaudeRequest {
  return {
    usage: emptyUsage(),
    tools: new Map(),
    model: '',
    lines: 0,
    sawUsage: false,
    sawStableId: true,
    sidechain: false,
    synthetic: false,
  };
}

/** Anthropic usage block → normalized counters. */
function claudeUsageFrom(raw: Record<string, unknown>): Usage {
  const details = asRecord(raw.output_tokens_details);
  return {
    input: num(raw.input_tokens),
    cacheRead: num(raw.cache_read_input_tokens),
    cacheWrite: num(raw.cache_creation_input_tokens),
    output: num(raw.output_tokens),
    thinking: details !== null ? num(details.thinking_tokens) : 0,
  };
}

/**
 * Read one Claude Code transcript.
 *
 * `message.id` never spans files (verified over the local corpus: 22,325 ids,
 * 0 spanning two files), so accumulating per file is safe and keeps memory
 * bounded by the largest single session.
 */
async function extractClaudeCodeFile(
  path: string,
  workspaceSlug: string,
  records: TurnRecord[],
  stats: ScanStats,
): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    stats.filesSkipped += 1;
    return;
  }

  const subagent = path.includes(`${sep}subagents${sep}`);
  // Subagent transcripts live at `{slug}/{sessionId}/subagents/agent-*.jsonl`
  // and carry the PARENT session id in their records; fall back to the folder.
  const agentId = subagent ? basename(path, '.jsonl').replace(/^agent-/, '') : undefined;
  const folderSessionId = subagent
    ? basename(resolve(path, '..', '..'))
    : basename(path, '.jsonl');

  const byRequest = new Map<string, ClaudeRequest>();
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.type !== 'assistant') continue;
    const message = asRecord(obj.message);
    if (message === null) continue;

    const stableId = str(message.id);
    // With no stable id, each line must stand alone — otherwise unrelated
    // responses would merge. The per-line uuid is unique, so it is safe.
    const requestId = stableId ?? str(obj.uuid) ?? `line-${byRequest.size}`;

    let entry = byRequest.get(requestId);
    if (entry === undefined) {
      entry = newClaudeRequest();
      byRequest.set(requestId, entry);
    }
    entry.lines += 1;
    if (stableId === undefined) entry.sawStableId = false;

    const rawUsage = asRecord(message.usage);
    if (rawUsage !== null) {
      entry.sawUsage = true;
      stats.linesWithUsage += 1;
      maxUsage(entry.usage, claudeUsageFrom(rawUsage));
    }

    // Union this line's content blocks into the request.
    const content = message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = asRecord(block);
        if (b === null || b.type !== 'tool_use') continue;
        const name = str(b.name) ?? 'Tool';
        const blockId = str(b.id) ?? `${name}:${entry.tools.size}`;
        if (!entry.tools.has(blockId)) entry.tools.set(blockId, { name, kind: 'tool_use' });
      }
    }

    const model = str(message.model);
    if (model !== undefined) {
      if (entry.model.length === 0) entry.model = model;
      if (model === '<synthetic>') entry.synthetic = true;
    }
    if (entry.firstTs === undefined) entry.firstTs = str(obj.timestamp);
    if (entry.cwd === undefined) entry.cwd = str(obj.cwd);
    if (obj.isSidechain === true) entry.sidechain = true;
  }

  const sessionId = folderSessionId;
  for (const [requestId, entry] of byRequest) {
    const flags: RecordFlag[] = [];
    if (entry.synthetic) flags.push('synthetic-model');
    if (!entry.sawUsage) flags.push('missing-usage');
    if (!entry.sawStableId) flags.push('no-request-id');
    records.push({
      engine: CLAUDE_CODE_ENGINE,
      sessionId,
      agentId,
      sidechain: entry.sidechain,
      workspaceSlug,
      workspaceCwd: entry.cwd,
      model: entry.model.length > 0 ? entry.model : '<unknown>',
      ts: entry.firstTs,
      requestId,
      usage: entry.usage,
      tools: [...entry.tools.values()],
      lines: entry.lines,
      flags,
    });
  }
  stats.filesScanned += 1;
}

// ── codex ──────────────────────────────────────────────────────────

const CODEX_TOOL_TYPES = new Set([
  'function_call',
  'custom_tool_call',
  'local_shell_call',
  'web_search_call',
]);

function codexToolFrom(payload: Record<string, unknown>): ToolUse | null {
  const type = payload.type;
  if (typeof type !== 'string' || !CODEX_TOOL_TYPES.has(type)) return null;
  if (type === 'local_shell_call') return { name: 'Shell', kind: type };
  if (type === 'web_search_call') return { name: 'WebSearch', kind: type };
  return { name: str(payload.name) ?? 'Tool', kind: type };
}

/**
 * Codex `last_token_usage` → normalized `Usage`.
 *
 * `input_tokens` is the FULL prompt (cached included), so the uncached portion
 * is the difference. `total_tokens == input + output` held on 2,392 of 2,396
 * local events; the four outliers are all-zero markers skipped below.
 */
function codexUsageFrom(raw: Record<string, unknown>): Usage {
  const input = num(raw.input_tokens);
  const cacheRead = num(raw.cached_input_tokens);
  return {
    input: Math.max(0, input - cacheRead),
    cacheRead,
    cacheWrite: num(raw.cache_write_input_tokens),
    output: num(raw.output_tokens),
    thinking: num(raw.reasoning_output_tokens),
  };
}

async function extractCodexFile(
  path: string,
  records: TurnRecord[],
  stats: ScanStats,
): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    stats.filesSkipped += 1;
    return;
  }

  let sessionId = basename(path, '.jsonl');
  let cwd: string | undefined;
  let model = '<unknown>';
  let rolledBack = false;
  let seq = 0;
  // Index of this file's first record, so a rollback discovered at the end can
  // be applied to the whole session — including the earlier turns that were
  // rewound, which are exactly the ones whose deltas no longer reconcile.
  const firstRecord = records.length;
  // Tools emitted since the previous token_count belong to the response that
  // produces the next one — Codex reports usage after the model responds.
  let pending: ToolUse[] = [];

  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = asRecord(obj.payload) ?? {};
    const type = obj.type;

    if (type === 'session_meta') {
      sessionId = str(payload.id) ?? sessionId;
      cwd = str(payload.cwd) ?? cwd;
      continue;
    }
    if (type === 'turn_context') {
      model = str(payload.model) ?? model;
      cwd = cwd ?? str(payload.cwd);
      continue;
    }
    if (type !== 'event_msg') {
      if (type === 'response_item') {
        const tool = codexToolFrom(payload);
        if (tool !== null) pending.push(tool);
      }
      continue;
    }

    const kind = payload.type;
    if (kind === 'thread_rolled_back' || kind === 'turn_aborted') {
      rolledBack = true;
      continue;
    }
    if (kind !== 'token_count') continue;

    // Old rollouts carry `info: null` — nothing to attribute, not an error.
    const info = asRecord(payload.info);
    if (info === null) continue;
    const lastRaw = asRecord(info.last_token_usage);
    if (lastRaw === null) continue;

    const usage = codexUsageFrom(lastRaw);
    const tools = pending;
    pending = [];
    // All-zero markers are context bookkeeping, not model requests.
    if (isZeroUsage(usage)) continue;

    stats.linesWithUsage += 1;
    seq += 1;
    records.push({
      engine: CODEX_ENGINE,
      sessionId,
      sidechain: false,
      workspaceSlug: cwd !== undefined ? claudeProjectSlug(cwd) : '<unknown>',
      workspaceCwd: cwd,
      model,
      ts: str(obj.timestamp),
      requestId: `${sessionId}#${seq}`,
      usage,
      tools,
      lines: 1,
      flags: [],
    });
  }

  if (rolledBack) {
    for (let i = firstRecord; i < records.length; i += 1) {
      const record = records[i];
      if (record !== undefined && !record.flags.includes('rollback')) {
        record.flags.push('rollback');
      }
    }
  }

  // Stub rollouts (8-20 lines) legitimately report no usage at all; they
  // contribute no records and are not an error.
  stats.filesScanned += 1;
}

// ── discovery ──────────────────────────────────────────────────────

interface Candidate {
  path: string;
  engine: string;
  /** Known up front for claude-code; resolved from `session_meta` for codex. */
  workspaceSlug: string;
}

async function listClaudeCodeFiles(root: string): Promise<Candidate[]> {
  let slugs: string[];
  try {
    slugs = await readdir(root);
  } catch {
    return [];
  }
  const out: Candidate[] = [];
  for (const slug of slugs) {
    const dir = join(root, slug);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.isFile() && ent.name.endsWith('.jsonl')) {
        out.push({ path: join(dir, ent.name), engine: CLAUDE_CODE_ENGINE, workspaceSlug: slug });
        continue;
      }
      if (!ent.isDirectory()) continue;
      // Sub-agent transcripts: `{slug}/{sessionId}/subagents/agent-*.jsonl`.
      const subDir = join(dir, ent.name, 'subagents');
      let subs;
      try {
        subs = await readdir(subDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sub of subs) {
        if (!sub.isFile() || !sub.name.endsWith('.jsonl')) continue;
        out.push({
          path: join(subDir, sub.name),
          engine: CLAUDE_CODE_ENGINE,
          workspaceSlug: slug,
        });
      }
    }
  }
  return out;
}

async function listCodexFiles(root: string): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (ent.isFile() && ent.name.endsWith('.jsonl')) {
        out.push({ path: full, engine: CODEX_ENGINE, workspaceSlug: '' });
      }
    }
  }
  return out;
}

// ── filtering ──────────────────────────────────────────────────────

/**
 * Workspace filter: accepts a raw slug (`-Users-me-proj`), an absolute path
 * (encoded via {@link claudeProjectSlug}), or a loose fragment so
 * `--workspace agent-bridge` finds `-Users-me-ws-agent-bridge`.
 */
export function workspaceMatches(recordSlug: string, filter: string): boolean {
  if (recordSlug === filter) return true;
  if (filter.startsWith('/') && recordSlug === claudeProjectSlug(filter)) return true;
  const needle = filter.replace(/\//g, '-').replace(/^-+/, '');
  if (needle.length === 0) return false;
  return recordSlug.replace(/^-+/, '').includes(needle);
}

function tsInRange(ts: string | undefined, since?: string, until?: string): boolean {
  // Records without a timestamp cannot be placed on the timeline; keep them
  // only when no time bound was requested.
  if (ts === undefined) return since === undefined && until === undefined;
  if (since !== undefined && ts < since) return false;
  if (until !== undefined && ts >= until) return false;
  return true;
}

function matches(record: TurnRecord, filters: AnalyzeFilters): boolean {
  if (filters.engine !== undefined && record.engine !== filters.engine) return false;
  if (filters.workspace !== undefined && !workspaceMatches(record.workspaceSlug, filters.workspace)) {
    return false;
  }
  if (filters.session !== undefined) {
    const needle = filters.session;
    const hit =
      record.sessionId === needle
      || record.sessionId.startsWith(needle)
      || (record.agentId !== undefined && record.agentId.startsWith(needle));
    if (!hit) return false;
  }
  return tsInRange(record.ts, filters.since, filters.until);
}

// ── entry point ────────────────────────────────────────────────────

export interface ScanOptions {
  filters?: AnalyzeFilters;
  roots?: Partial<ScanRoots>;
  /** Restrict to one engine, skipping other readers entirely. */
  engines?: string[];
}

/**
 * Walk every transcript store and return deduped, normalized request records.
 */
export async function scanSessions(options: ScanOptions = {}): Promise<ScanResult> {
  const roots = { ...defaultScanRoots(), ...options.roots };
  const filters = options.filters ?? {};
  const warnings: string[] = [];
  const records: TurnRecord[] = [];
  const stats: ScanStats = {
    filesScanned: 0,
    filesSkipped: 0,
    linesWithUsage: 0,
    requests: 0,
    collapseRatio: 1,
  };

  const wanted = options.engines;
  const wantClaude = wanted === undefined || wanted.includes(CLAUDE_CODE_ENGINE);
  const wantCodex = wanted === undefined || wanted.includes(CODEX_ENGINE);

  if (wantClaude) {
    const files = await listClaudeCodeFiles(roots.claudeProjectsDir);
    if (files.length === 0) {
      warnings.push(`no claude-code transcripts found under ${roots.claudeProjectsDir}`);
    }
    for (const file of files) {
      await extractClaudeCodeFile(file.path, file.workspaceSlug, records, stats);
    }
  }
  if (wantCodex) {
    const files = await listCodexFiles(roots.codexSessionsDir);
    for (const file of files) {
      await extractCodexFile(file.path, records, stats);
    }
  }

  const kept = records.filter((r) => matches(r, filters));
  stats.requests = kept.length;

  // The streaming-inflation factor only means anything for claude-code, whose
  // transcripts are one line per content block. Deriving it from the surviving
  // records keeps it exact instead of diluted by codex's one-line requests.
  let claudeLines = 0;
  let claudeRequests = 0;
  for (const record of kept) {
    if (record.engine !== CLAUDE_CODE_ENGINE) continue;
    claudeLines += record.lines;
    claudeRequests += 1;
  }
  stats.collapseRatio = claudeRequests > 0 ? claudeLines / claudeRequests : 1;

  return { records: kept, stats, warnings };
}
