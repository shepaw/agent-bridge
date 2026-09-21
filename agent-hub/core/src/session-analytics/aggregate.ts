/**
 * Dimension aggregation over extracted `TurnRecord`s.
 *
 * Every table here is derived from *requests*, the granularity at which the
 * provider reports tokens. Where a number cannot be attributed honestly it is
 * either omitted or explicitly labelled — see `ToolStat`.
 */

import type { TurnRecord, Usage } from './types.js';
import { addUsage, emptyUsage } from './types.js';

/** One row of a grouped table. */
export interface GroupTotals {
  key: string;
  requests: number;
  usage: Usage;
  /** Tool invocations observed in these requests' responses. */
  toolCalls: number;
  firstTs?: string;
  lastTs?: string;
}

export interface Distribution {
  count: number;
  min: number;
  median: number;
  p95: number;
  max: number;
  mean: number;
}

/**
 * Tool frequency, keyed by tool NAME.
 *
 * The same tool can surface under different source kinds across engines — the
 * claude-code `tool_use` block `WebSearch` and codex's `web_search_call` are
 * one tool as far as an operator is concerned. Counting them apart would put
 * two identically-named rows in the report, so they merge and the source kinds
 * are retained in `kinds` for anyone who needs to disambiguate.
 *
 * `calls` and `requests` are exact and independent of token accounting.
 * `requestOutput` is the output tokens of the requests this tool appeared in —
 * it is CONTEXT, not consumption: one request may contain several tools, and
 * its usage is reported once for the request, not per tool. Summing this
 * column across tools double-counts, so the report never does.
 */
export interface ToolStat {
  name: string;
  /** Source block/event types this name was seen under, sorted. */
  kinds: string[];
  calls: number;
  requests: number;
  requestOutput: number;
}

export interface AnomalySummary {
  syntheticRequests: number;
  missingUsageRequests: number;
  noRequestIdRequests: number;
  unknownModelRequests: number;
  rollbackRequests: number;
  /** Sessions touched by a codex rollback, worst-first. */
  rollbackSessions: string[];
}

export interface Aggregate {
  totals: GroupTotals;
  byEngine: GroupTotals[];
  byWorkspace: GroupTotals[];
  bySession: GroupTotals[];
  byModel: GroupTotals[];
  byDay: GroupTotals[];
  tools: ToolStat[];
  /** Per-request output tokens — the spread that averages hide. */
  outputDistribution: Distribution;
  /** `cacheRead / (input + cacheRead)`; 0 when no prompt tokens were seen. */
  cacheEfficiency: number;
  /** Sum of `lines` across claude-code requests / that request count. */
  collapseRatio: number;
  anomalies: AnomalySummary;
  sidechainRequests: number;
  sidechainOutput: number;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const first = sorted[0] ?? 0;
  if (sorted.length === 1) return first;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const loV = sorted[lo] ?? first;
  const hiV = sorted[hi] ?? loV;
  return loV + (hiV - loV) * (idx - lo);
}

export function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) {
    return { count: 0, min: 0, median: 0, p95: 0, max: 0, mean: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  let sum = 0;
  for (const v of values) sum += v;
  return {
    count: sorted.length,
    min: sorted[0] ?? 0,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1] ?? 0,
    mean: sum / sorted.length,
  };
}

interface Bucket {
  totals: GroupTotals;
}

function bucketFor(map: Map<string, Bucket>, key: string): GroupTotals {
  let bucket = map.get(key);
  if (bucket === undefined) {
    bucket = {
      totals: { key, requests: 0, usage: emptyUsage(), toolCalls: 0 },
    };
    map.set(key, bucket);
  }
  return bucket.totals;
}

function observe(totals: GroupTotals, record: TurnRecord): void {
  totals.requests += 1;
  addUsage(totals.usage, record.usage);
  totals.toolCalls += record.tools.length;
  if (record.ts !== undefined) {
    if (totals.firstTs === undefined || record.ts < totals.firstTs) totals.firstTs = record.ts;
    if (totals.lastTs === undefined || record.ts > totals.lastTs) totals.lastTs = record.ts;
  }
}

/** Most-consumed first; ties broken by key for stable output. */
function rowsOf(map: Map<string, Bucket>): GroupTotals[] {
  const rows = [...map.values()].map((b) => b.totals);
  rows.sort((a, b) => b.usage.output - a.usage.output || a.key.localeCompare(b.key));
  return rows;
}

export function aggregate(records: readonly TurnRecord[], collapseRatio = 1): Aggregate {
  const byEngine = new Map<string, Bucket>();
  const byWorkspace = new Map<string, Bucket>();
  const bySession = new Map<string, Bucket>();
  const byModel = new Map<string, Bucket>();
  const byDay = new Map<string, Bucket>();

  const toolAgg = new Map<string, ToolStat>();
  const outputValues: number[] = [];
  const totals: GroupTotals = { key: 'all', requests: 0, usage: emptyUsage(), toolCalls: 0 };

  const anomalies: AnomalySummary = {
    syntheticRequests: 0,
    missingUsageRequests: 0,
    noRequestIdRequests: 0,
    unknownModelRequests: 0,
    rollbackRequests: 0,
    rollbackSessions: [],
  };
  const rollbackSessions = new Set<string>();
  let sidechainRequests = 0;
  let sidechainOutput = 0;

  for (const record of records) {
    observe(totals, record);
    observe(bucketFor(byEngine, record.engine), record);
    observe(bucketFor(byWorkspace, record.workspaceSlug), record);
    observe(bucketFor(bySession, record.sessionId), record);
    observe(bucketFor(byModel, record.model), record);
    // Requests without a timestamp would silently vanish from the timeline;
    // they get their own row so the day table still sums to the total.
    observe(bucketFor(byDay, record.ts?.slice(0, 10) ?? 'unknown'), record);

    outputValues.push(record.usage.output);

    if (record.sidechain) {
      sidechainRequests += 1;
      sidechainOutput += record.usage.output;
    }
    if (record.model === '<synthetic>') anomalies.syntheticRequests += 1;
    if (record.model === '<unknown>') anomalies.unknownModelRequests += 1;
    if (record.flags.includes('missing-usage')) anomalies.missingUsageRequests += 1;
    if (record.flags.includes('no-request-id')) anomalies.noRequestIdRequests += 1;
    if (record.flags.includes('rollback')) {
      anomalies.rollbackRequests += 1;
      rollbackSessions.add(record.sessionId);
    }

    for (const tool of record.tools) {
      let stat = toolAgg.get(tool.name);
      if (stat === undefined) {
        stat = { name: tool.name, kinds: [], calls: 0, requests: 0, requestOutput: 0 };
        toolAgg.set(tool.name, stat);
      }
      stat.calls += 1;
      if (!stat.kinds.includes(tool.kind)) stat.kinds.push(tool.kind);
    }
    // Per-request attribution: a tool seen twice in one response counts as one
    // request, and the request's tokens are attributed to it once.
    const seenHere = new Set<string>();
    for (const tool of record.tools) {
      if (seenHere.has(tool.name)) continue;
      seenHere.add(tool.name);
      const stat = toolAgg.get(tool.name);
      if (stat !== undefined) {
        stat.requests += 1;
        stat.requestOutput += record.usage.output;
      }
    }
  }

  const tools = [...toolAgg.values()];
  tools.sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
  for (const tool of tools) tool.kinds.sort();

  const promptTokens = totals.usage.input + totals.usage.cacheRead;
  anomalies.rollbackSessions = [...rollbackSessions].sort();

  return {
    totals,
    byEngine: rowsOf(byEngine),
    byWorkspace: rowsOf(byWorkspace),
    bySession: rowsOf(bySession),
    byModel: rowsOf(byModel),
    byDay: byDay.size > 0
      ? [...byDay.values()].map((b) => b.totals).sort((a, b) => a.key.localeCompare(b.key))
      : [],
    tools,
    outputDistribution: distribution(outputValues),
    cacheEfficiency: promptTokens > 0 ? totals.usage.cacheRead / promptTokens : 0,
    collapseRatio,
    anomalies,
    sidechainRequests,
    sidechainOutput,
  };
}
