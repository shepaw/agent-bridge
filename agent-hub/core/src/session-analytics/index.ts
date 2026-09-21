/**
 * Post-hoc session analytics: what an agent did, which tools it called, and
 * where the tokens went — read entirely from the transcripts already on disk.
 *
 * Deliberately offline. Nothing here touches the ACP layer, the gateway's
 * `/status`, or any live stream: it reads finished transcript files, so it can
 * answer questions about history that was never instrumented at the time.
 *
 * Landing here rather than in acp-proxy's `disk-history/` is intentional. That
 * reader emits `DiskHistoryMessage` — the UI chat shape — and widening it with
 * usage fields would grow a public SDK type for a purely analytical payoff.
 */

export type {
  AnalyzeFilters,
  RecordFlag,
  ScanResult,
  ScanRoots,
  ScanStats,
  ToolUse,
  TurnRecord,
  Usage,
} from './types.js';
export { addUsage, emptyUsage } from './types.js';

export {
  CLAUDE_CODE_ENGINE,
  CODEX_ENGINE,
  claudeProjectSlug,
  defaultScanRoots,
  scanSessions,
  workspaceMatches,
  type ScanOptions,
} from './extract.js';

export {
  aggregate,
  distribution,
  type Aggregate,
  type AnomalySummary,
  type Distribution,
  type GroupTotals,
  type ToolStat,
} from './aggregate.js';

export { renderJson, renderMarkdown } from './report.js';

import { aggregate, type Aggregate } from './aggregate.js';
import { scanSessions } from './extract.js';
import { renderJson, renderMarkdown } from './report.js';
import type { AnalyzeFilters, ScanResult } from './types.js';

export interface AnalyzeOptions extends AnalyzeFilters {
  /** Emit JSON instead of Markdown. */
  json?: boolean;
  /** Override transcript roots (tests / non-standard installs). */
  roots?: { claudeProjectsDir?: string; codexSessionsDir?: string };
  /** Restrict the scan to specific engines. */
  engines?: string[];
}

export interface AnalyzeOutput {
  /** Rendered report — Markdown unless `json` was set. */
  text: string;
  scan: ScanResult;
  aggregate: Aggregate;
  filters: AnalyzeFilters;
}

/**
 * Scan, aggregate, and render in one call.
 *
 * Filtering happens after extraction: a transcript records the workspace only
 * on individual lines (and codex only inside `session_meta`), so deciding what
 * to skip requires reading the file anyway.
 */
export async function runAnalyze(options: AnalyzeOptions = {}): Promise<AnalyzeOutput> {
  const filters: AnalyzeFilters = {};
  if (options.session !== undefined) filters.session = options.session;
  if (options.workspace !== undefined) filters.workspace = options.workspace;
  if (options.instance !== undefined) filters.instance = options.instance;
  if (options.engine !== undefined) filters.engine = options.engine;
  if (options.since !== undefined) filters.since = options.since;
  if (options.until !== undefined) filters.until = options.until;

  const scan = await scanSessions({
    filters,
    ...(options.roots !== undefined ? { roots: options.roots } : {}),
    ...(options.engines !== undefined ? { engines: options.engines } : {}),
  });
  const agg = aggregate(scan.records, scan.stats.collapseRatio);
  const text = options.json === true
    ? renderJson(scan, agg, filters)
    : renderMarkdown(scan, agg, filters);
  return { text, scan, aggregate: agg, filters };
}
