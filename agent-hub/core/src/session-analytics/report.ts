/**
 * Markdown / JSON rendering of an {@link Aggregate}.
 *
 * The methodology block is not decoration. Every headline number here depends
 * on a dedupe rule and a normalization decision that a reader cannot infer
 * from the table, and the tool table invites an attribution that the data does
 * not support. The report states both up front so the numbers cannot be
 * quoted out of context.
 */

import type { Aggregate, GroupTotals, ToolStat } from './aggregate.js';
import type { AnalyzeFilters, ScanResult } from './types.js';

function commas(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** `1234567` → `1.23M` — for columns where magnitude is what matters. */
function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function promptTokens(g: GroupTotals): number {
  return g.usage.input + g.usage.cacheRead + g.usage.cacheWrite;
}

function totalTokens(g: GroupTotals): number {
  return promptTokens(g) + g.usage.output;
}

function filtersLine(filters: AnalyzeFilters): string {
  const parts: string[] = [];
  if (filters.engine !== undefined) parts.push(`engine=${filters.engine}`);
  if (filters.workspace !== undefined) parts.push(`workspace=${filters.workspace}`);
  if (filters.session !== undefined) parts.push(`session=${filters.session}`);
  if (filters.instance !== undefined) parts.push(`instance=${filters.instance}`);
  if (filters.since !== undefined) parts.push(`since=${filters.since}`);
  if (filters.until !== undefined) parts.push(`until=${filters.until}`);
  return parts.length > 0 ? parts.join('  ') : '(none — whole machine)';
}

const GROUP_HEADER =
  '| Key | Requests | Input | Cache read | Cache write | Output | Thinking | Total |';
const GROUP_RULE =
  '|---|---:|---:|---:|---:|---:|---:|---:|';

function groupTable(rows: readonly GroupTotals[], keyLabel: string, keyWidth = 0): string[] {
  if (rows.length === 0) return ['_no data_', ''];
  const out = [GROUP_HEADER.replace('Key', keyLabel), GROUP_RULE];
  for (const row of rows) {
    const key = keyWidth > 0 && row.key.length > keyWidth
      ? `${row.key.slice(0, keyWidth - 1)}…`
      : row.key;
    out.push(
      `| ${key} | ${commas(row.requests)} | ${compact(row.usage.input)} | `
      + `${compact(row.usage.cacheRead)} | ${compact(row.usage.cacheWrite)} | `
      + `${compact(row.usage.output)} | ${compact(row.usage.thinking)} | `
      + `${compact(totalTokens(row))} |`,
    );
  }
  out.push('');
  return out;
}

function toolTable(tools: readonly ToolStat[]): string[] {
  if (tools.length === 0) return ['_no tool calls recorded_', ''];
  const out = [
    '| Tool | Calls | Requests containing it | Output tokens in those requests |',
    '|---|---:|---:|---:|',
  ];
  for (const t of tools) {
    // A name reached through more than one engine's event shape is worth
    // flagging, otherwise the merged count looks like it contradicts a
    // per-engine reading of the same data.
    const label = t.kinds.length > 1 ? `${t.name} _(${t.kinds.join(', ')})_` : t.name;
    out.push(
      `| ${label} | ${commas(t.calls)} | ${commas(t.requests)} | ${commas(t.requestOutput)} |`,
    );
  }
  out.push('');
  return out;
}

export function renderMarkdown(
  result: ScanResult,
  agg: Aggregate,
  filters: AnalyzeFilters,
): string {
  const { stats, warnings } = result;
  const t = agg.totals;
  const lines: string[] = [];

  lines.push('# Session analytics');
  lines.push('');
  lines.push(`Scope: ${filtersLine(filters)}`);
  lines.push('');
  lines.push(
    `Scanned ${commas(stats.filesScanned)} transcript files `
    + `(${commas(stats.filesSkipped)} unreadable) → `
    + `${commas(stats.linesWithUsage)} transcript lines carrying usage → `
    + `**${commas(stats.requests)} model requests**.`,
  );
  lines.push('');
  lines.push('## How to read these numbers');
  lines.push('');
  lines.push(
    `- **Dedupe.** Claude Code writes one JSONL line per content block, repeating `
    + `\`message.id\` and its cumulative usage on every line. Usage is collapsed per `
    + `\`message.id\` keeping the final (largest) snapshot. Raw summation would inflate `
    + `these figures — here each request averages ${stats.collapseRatio.toFixed(2)} lines.`,
  );
  lines.push(
    '- **Codes.** Claude Code\'s `input_tokens` is UNCACHED prompt only; Codex\'s includes '
    + 'cached tokens. Codex values are normalized by subtracting the cached portion.',
  );
  lines.push(
    '- **Token attribution to tools does not exist.** One request may contain several '
    + 'tool calls, and usage is reported once per request, not per tool. So there is no '
    + 'exact "tool X cost N tokens". The tools table shows calls and request counts, '
    + 'which are exact, plus the output tokens of the requests a tool appeared in — '
    + 'context, not consumption. That column must not be summed across tools.',
  );
  lines.push(
    '- **Codex per-turn tokens** come from `last_token_usage` deltas, because '
    + '`total_token_usage` is cumulative and can rewind on rollback.',
  );
  lines.push('');

  lines.push('## Totals');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---:|');
  lines.push(`| Model requests | ${commas(t.requests)} |`);
  lines.push(`| Input (uncached) | ${commas(t.usage.input)} |`);
  lines.push(`| Cache read | ${commas(t.usage.cacheRead)} |`);
  lines.push(`| Cache write | ${commas(t.usage.cacheWrite)} |`);
  lines.push(`| Output | ${commas(t.usage.output)} |`);
  lines.push(`| — of which thinking | ${commas(t.usage.thinking)} |`);
  lines.push(`| Prompt tokens | ${commas(promptTokens(t))} |`);
  lines.push(`| Total tokens | ${commas(totalTokens(t))} |`);
  lines.push(`| Tool calls | ${commas(t.toolCalls)} |`);
  lines.push(`| Cache efficiency (cacheRead / prompt) | ${pct(agg.cacheEfficiency)} |`);
  if (agg.sidechainRequests > 0) {
    lines.push(
      `| Sub-agent requests | ${commas(agg.sidechainRequests)} `
      + `(${commas(agg.sidechainOutput)} output tokens) |`,
    );
  }
  lines.push('');

  lines.push('## Per-request output distribution');
  lines.push('');
  const d = agg.outputDistribution;
  lines.push('| Count | Min | Median | p95 | Max | Mean |');
  lines.push('|---:|---:|---:|---:|---:|---:|');
  lines.push(
    `| ${commas(d.count)} | ${commas(d.min)} | ${commas(d.median)} | `
    + `${commas(d.p95)} | ${commas(d.max)} | ${commas(d.mean)} |`,
  );
  lines.push('');

  lines.push('## By engine');
  lines.push('');
  lines.push(...groupTable(agg.byEngine, 'Engine'));

  lines.push('## By model');
  lines.push('');
  lines.push(...groupTable(agg.byModel, 'Model'));

  lines.push('## By workspace');
  lines.push('');
  lines.push(...groupTable(agg.byWorkspace, 'Workspace', 60));

  lines.push('## By day');
  lines.push('');
  lines.push(...groupTable(agg.byDay, 'Day'));

  lines.push('## Tools');
  lines.push('');
  lines.push(...toolTable(agg.tools));

  lines.push('## By session');
  lines.push('');
  lines.push(...groupTable(agg.bySession, 'Session', 40));

  lines.push('## Anomalies');
  lines.push('');
  const a = agg.anomalies;
  lines.push('| Signal | Requests |');
  lines.push('|---|---:|');
  lines.push(`| \`<synthetic>\` model (engine error turn) | ${commas(a.syntheticRequests)} |`);
  lines.push(`| Missing usage object | ${commas(a.missingUsageRequests)} |`);
  lines.push(`| No stable request id | ${commas(a.noRequestIdRequests)} |`);
  lines.push(`| Unknown model | ${commas(a.unknownModelRequests)} |`);
  lines.push(`| Inside a rolled-back codex turn | ${commas(a.rollbackRequests)} |`);
  lines.push('');
  if (a.rollbackSessions.length > 0) {
    lines.push(
      `Codex sessions that rewound (summed \`last_token_usage\` will exceed that `
      + `session's final \`total_token_usage\`): ${a.rollbackSessions.join(', ')}.`,
    );
    lines.push('');
  }
  if (warnings.length > 0) {
    lines.push('Warnings:');
    lines.push('');
    for (const w of warnings) lines.push(`- ${w}`);
    lines.push('');
  }

  return lines.join('\n');
}

export function renderJson(
  result: ScanResult,
  agg: Aggregate,
  filters: AnalyzeFilters,
): string {
  return `${JSON.stringify(
    {
      scope: filters,
      scan: result.stats,
      warnings: result.warnings,
      totals: agg.totals,
      cacheEfficiency: agg.cacheEfficiency,
      outputDistribution: agg.outputDistribution,
      sidechain: { requests: agg.sidechainRequests, output: agg.sidechainOutput },
      byEngine: agg.byEngine,
      byModel: agg.byModel,
      byWorkspace: agg.byWorkspace,
      byDay: agg.byDay,
      bySession: agg.bySession,
      tools: agg.tools,
      anomalies: agg.anomalies,
    },
    null,
    2,
  )}\n`;
}
