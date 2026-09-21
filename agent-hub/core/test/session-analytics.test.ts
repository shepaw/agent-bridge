/**
 * Session analytics — the invariants that make the numbers trustworthy.
 *
 * These tests pin the four rules documented at the top of `extract.ts`. Two of
 * them (keep the FINAL usage snapshot, UNION the content blocks) are the
 * opposite of the obvious reading and were the source of large errors when
 * done the naive way, so they get explicit regression coverage.
 */

import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  aggregate,
  claudeProjectSlug,
  renderMarkdown,
  runAnalyze,
  scanSessions,
  workspaceMatches,
} from '../src/session-analytics/index.js';
import type { TurnRecord } from '../src/session-analytics/index.js';

let root: string;
let claudeDir: string;
let codexDir: string;

const SLUG = '-Users-me-proj';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'shepaw-analytics-'));
  claudeDir = join(root, 'claude', 'projects');
  codexDir = join(root, 'codex', 'sessions');
  mkdirSync(join(claudeDir, SLUG), { recursive: true });
  mkdirSync(join(codexDir, '2026', '09', '01'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write a claude-code transcript at `{claudeDir}/{slug}/{sessionId}.jsonl`. */
function writeClaude(sessionId: string, lines: unknown[], slug = SLUG): string {
  const dir = join(claudeDir, slug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
  return path;
}

/** Write a sub-agent transcript at `{slug}/{sessionId}/subagents/agent-{id}.jsonl`. */
function writeSubagent(sessionId: string, agentId: string, lines: unknown[]): string {
  const dir = join(claudeDir, SLUG, sessionId, 'subagents');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `agent-${agentId}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
  return path;
}

interface ClaudeLineOptions {
  model?: string;
  usage?: Record<string, unknown> | null;
  sidechain?: boolean;
  ts?: string;
  cwd?: string;
}

function assistantLine(
  messageId: string,
  content: unknown[],
  opts: ClaudeLineOptions = {},
): Record<string, unknown> {
  return {
    type: 'assistant',
    uuid: `uuid-${Math.random().toString(36).slice(2)}`,
    timestamp: opts.ts ?? '2026-09-01T10:00:00.000Z',
    ...(opts.sidechain === true ? { isSidechain: true } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    message: {
      id: messageId,
      role: 'assistant',
      model: opts.model ?? 'claude-sonnet-5',
      content,
      ...(opts.usage === null
        ? {}
        : {
            usage: opts.usage ?? {
              input_tokens: 100,
              cache_read_input_tokens: 50,
              cache_creation_input_tokens: 5,
              output_tokens: 120,
              output_tokens_details: { thinking_tokens: 30 },
            },
          }),
    },
  };
}

function codexLine(obj: unknown): string {
  return JSON.stringify(obj);
}

function writeCodex(name: string, lines: string[]): string {
  const path = join(codexDir, '2026', '09', '01', name);
  writeFileSync(path, lines.join('\n') + '\n', 'utf-8');
  return path;
}

async function scan(): Promise<TurnRecord[]> {
  const result = await scanSessions({
    roots: { claudeProjectsDir: claudeDir, codexSessionsDir: codexDir },
  });
  return result.records;
}

describe('claude-code extraction', () => {
  it('collapses one request spread over per-content-block lines', async () => {
    // Claude Code writes one line per content block, repeating message.id and
    // a cumulative usage snapshot on each. Three lines, one request.
    writeClaude('sess-a', [
      assistantLine('msg-1', [{ type: 'thinking', thinking: 'hmm' }], {
        usage: { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 0 },
      }),
      assistantLine('msg-1', [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: {} }], {
        usage: { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 0 },
      }),
      assistantLine('msg-1', [{ type: 'text', text: 'done' }], {
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 5,
          output_tokens: 120,
          output_tokens_details: { thinking_tokens: 30 },
        },
      }),
    ]);

    const records = await scan();
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.lines).toBe(3);
    // FINAL snapshot, not the first: line 1 reports output_tokens 0.
    expect(rec.usage).toEqual({
      input: 100,
      cacheRead: 50,
      cacheWrite: 5,
      output: 120,
      thinking: 30,
    });
  });

  it('unions tool calls across the lines of one request', async () => {
    // The tool_use block is almost never on the first line; taking only the
    // first line would drop it entirely (~92% of calls corpus-wide).
    writeClaude('sess-b', [
      assistantLine('msg-1', [{ type: 'thinking', thinking: 'hmm' }]),
      assistantLine('msg-1', [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: {} }]),
      assistantLine('msg-1', [{ type: 'tool_use', id: 'tu-2', name: 'Edit', input: {} }]),
    ]);

    const records = await scan();
    expect(records).toHaveLength(1);
    expect(records[0]!.tools.map((t) => t.name).sort()).toEqual(['Edit', 'Read']);
  });

  it('counts a tool_use block repeated across lines only once', async () => {
    // Dedupe is by block id, not by name: two Edit calls in one response are
    // two invocations, but one invocation echoed twice is one.
    writeClaude('sess-c', [
      assistantLine('msg-1', [{ type: 'tool_use', id: 'tu-1', name: 'Edit', input: {} }]),
      assistantLine('msg-1', [{ type: 'tool_use', id: 'tu-1', name: 'Edit', input: {} }]),
      assistantLine('msg-1', [{ type: 'tool_use', id: 'tu-2', name: 'Edit', input: {} }]),
    ]);

    const records = await scan();
    expect(records[0]!.tools).toHaveLength(2);
  });

  it('keeps requests separate by message.id', async () => {
    writeClaude('sess-d', [
      assistantLine('msg-1', [{ type: 'text', text: 'a' }]),
      assistantLine('msg-2', [{ type: 'text', text: 'b' }]),
    ]);
    expect(await scan()).toHaveLength(2);
  });

  it('flags <synthetic> model turns instead of trusting their zero usage', async () => {
    writeClaude('sess-e', [
      assistantLine('msg-1', [{ type: 'text', text: 'API Error: 402' }], {
        model: '<synthetic>',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
      }),
    ]);
    const records = await scan();
    expect(records[0]!.flags).toContain('synthetic-model');
    expect(records[0]!.usage.output).toBe(0);
  });

  it('tolerates an assistant line with no usage object', async () => {
    writeClaude('sess-f', [assistantLine('msg-1', [{ type: 'text', text: 'x' }], { usage: null })]);
    const records = await scan();
    expect(records).toHaveLength(1);
    expect(records[0]!.flags).toContain('missing-usage');
  });

  it('falls back to the line uuid when message.id is absent', async () => {
    // Without a stable id, merging lines would fuse unrelated responses, so
    // each line must stand alone and say so.
    const line = assistantLine('', [{ type: 'text', text: 'x' }]);
    (line.message as Record<string, unknown>).id = undefined;
    const line2 = assistantLine('', [{ type: 'text', text: 'y' }]);
    (line2.message as Record<string, unknown>).id = undefined;
    writeClaude('sess-g', [line, line2]);

    const records = await scan();
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.flags.includes('no-request-id'))).toBe(true);
  });

  it('attaches sub-agent transcripts to the parent session', async () => {
    writeSubagent('sess-parent', 'ag1', [
      assistantLine('msg-sub', [{ type: 'tool_use', id: 'tu-1', name: 'Grep', input: {} }], {
        sidechain: true,
      }),
    ]);
    const records = await scan();
    expect(records).toHaveLength(1);
    expect(records[0]!.sessionId).toBe('sess-parent');
    expect(records[0]!.agentId).toBe('ag1');
    expect(records[0]!.sidechain).toBe(true);
  });

  it('records the workspace slug from the directory name', async () => {
    writeClaude('sess-h', [assistantLine('msg-1', [{ type: 'text', text: 'x' }])], '-Users-me-other');
    const records = await scan();
    expect(records[0]!.workspaceSlug).toBe('-Users-me-other');
  });
});

describe('codex extraction', () => {
  const tokenCount = (
    input: number,
    cached: number,
    output: number,
    total: number,
  ): string => codexLine({
    type: 'event_msg',
    timestamp: '2026-09-01T11:00:00.000Z',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: total, cached_input_tokens: cached, output_tokens: output, total_tokens: total,
        },
        last_token_usage: {
          input_tokens: input, cached_input_tokens: cached, output_tokens: output,
          total_tokens: input + output,
        },
      },
    },
  });

  it('normalizes input to the uncached portion', async () => {
    // Codex input_tokens is the FULL prompt with cached as a subset, unlike
    // Anthropic's uncached-only figure. Unnormalized, cross-engine comparisons
    // and the cache-efficiency ratio are both wrong.
    writeCodex('rollout-a.jsonl', [
      codexLine({ type: 'session_meta', payload: { id: 'cx-1', cwd: '/Users/me/proj' } }),
      codexLine({ type: 'turn_context', payload: { model: 'gpt-x', cwd: '/Users/me/proj' } }),
      tokenCount(100, 40, 10, 110),
    ]);

    const records = await scan();
    expect(records).toHaveLength(1);
    expect(records[0]!.usage.input).toBe(60);
    expect(records[0]!.usage.cacheRead).toBe(40);
    expect(records[0]!.usage.output).toBe(10);
    expect(records[0]!.model).toBe('gpt-x');
    expect(records[0]!.workspaceSlug).toBe(claudeProjectSlug('/Users/me/proj'));
  });

  it('sums per-turn deltas to the session total', async () => {
    // The plan's cross-format check: with no rollback, the deltas reconcile.
    writeCodex('rollout-b.jsonl', [
      codexLine({ type: 'session_meta', payload: { id: 'cx-2', cwd: '/Users/me/proj' } }),
      tokenCount(100, 40, 10, 110),
      tokenCount(50, 20, 5, 165),
    ]);

    const records = await scan();
    const summed = records.reduce((n, r) => n + r.usage.input + r.usage.cacheRead + r.usage.output, 0);
    // Final cumulative total: input_tokens 165 (full prompt), output 15.
    expect(summed).toBe(165 + 15 - 15);
    expect(records).toHaveLength(2);
  });

  it('flags a rolled-back session rather than reconciling it', async () => {
    writeCodex('rollout-c.jsonl', [
      codexLine({ type: 'session_meta', payload: { id: 'cx-3', cwd: '/Users/me/proj' } }),
      tokenCount(100, 0, 10, 110),
      codexLine({ type: 'event_msg', payload: { type: 'thread_rolled_back' } }),
      tokenCount(100, 0, 10, 110),
    ]);

    const records = await scan();
    expect(records.every((r) => r.flags.includes('rollback'))).toBe(true);
  });

  it('skips token_count events whose info is null', async () => {
    // Old rollouts genuinely carry `info: null`; must not throw.
    writeCodex('rollout-d.jsonl', [
      codexLine({ type: 'session_meta', payload: { id: 'cx-4', cwd: '/Users/me/proj' } }),
      codexLine({ type: 'event_msg', payload: { type: 'token_count', info: null } }),
    ]);
    expect(await scan()).toHaveLength(0);
  });

  it('skips all-zero usage markers', async () => {
    writeCodex('rollout-e.jsonl', [
      codexLine({ type: 'session_meta', payload: { id: 'cx-5', cwd: '/Users/me/proj' } }),
      codexLine({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 0, output_tokens: 0, total_tokens: 509404 },
            last_token_usage: { input_tokens: 0, output_tokens: 0, total_tokens: 509404 },
          },
        },
      }),
    ]);
    expect(await scan()).toHaveLength(0);
  });

  it('attributes function_call tools to the following request', async () => {
    writeCodex('rollout-f.jsonl', [
      codexLine({ type: 'session_meta', payload: { id: 'cx-6', cwd: '/Users/me/proj' } }),
      codexLine({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command' } }),
      codexLine({ type: 'response_item', payload: { type: 'local_shell_call', action: { command: ['ls'] } } }),
      tokenCount(100, 0, 10, 110),
    ]);

    const records = await scan();
    expect(records[0]!.tools.map((t) => t.name)).toEqual(['exec_command', 'Shell']);
  });

  it('survives an 8-line stub rollout with no token_count at all', async () => {
    writeCodex('rollout-g.jsonl', [
      codexLine({ type: 'session_meta', payload: { id: 'cx-7', cwd: '/Users/me/proj' } }),
      codexLine({ type: 'event_msg', payload: { type: 'task_started' } }),
    ]);
    expect(await scan()).toHaveLength(0);
  });

  it('ignores unparseable lines instead of failing the file', async () => {
    writeCodex('rollout-h.jsonl', ['{not json', ...[]]);
    writeCodex('rollout-i.jsonl', [
      codexLine({ type: 'session_meta', payload: { id: 'cx-8', cwd: '/Users/me/proj' } }),
      '{broken',
      tokenCount(10, 0, 1, 11),
    ]);
    const records = await scan();
    expect(records).toHaveLength(1);
  });
});

describe('scan accounting', () => {
  it('reports the streaming collapse ratio for claude-code only', async () => {
    writeClaude('sess-a', [
      assistantLine('msg-1', [{ type: 'text', text: 'a' }]),
      assistantLine('msg-1', [{ type: 'text', text: 'b' }]),
      assistantLine('msg-1', [{ type: 'text', text: 'c' }]),
    ]);
    const result = await scanSessions({
      roots: { claudeProjectsDir: claudeDir, codexSessionsDir: codexDir },
    });
    // 3 lines → 1 request.
    expect(result.stats.collapseRatio).toBe(3);
    expect(result.stats.requests).toBe(1);
  });

  it('warns when the claude-code root is missing', async () => {
    const result = await scanSessions({
      roots: {
        claudeProjectsDir: join(root, 'nope'),
        codexSessionsDir: join(root, 'nope2'),
      },
    });
    expect(result.warnings.join(' ')).toContain('no claude-code transcripts');
    expect(result.records).toHaveLength(0);
  });

  it('skips an unreadable file without aborting the scan', async () => {
    writeClaude('sess-good', [assistantLine('msg-1', [{ type: 'text', text: 'x' }])]);
    const locked = writeClaude('sess-locked', [assistantLine('msg-2', [{ type: 'text', text: 'y' }])]);
    chmodSync(locked, 0o000);
    try {
      const result = await scanSessions({
        roots: { claudeProjectsDir: claudeDir, codexSessionsDir: codexDir },
      });
      expect(result.stats.requests).toBe(1);
      expect(result.stats.filesSkipped).toBe(1);
      expect(result.records[0]!.sessionId).toBe('sess-good');
    } finally {
      // Restore so afterEach can clean the tree up.
      chmodSync(locked, 0o600);
    }
  });

  it('ignores a directory that merely ends in .jsonl', async () => {
    // Only real transcript files are candidates; a hashed session folder must
    // not be reported as an unreadable file.
    writeClaude('sess-good', [assistantLine('msg-1', [{ type: 'text', text: 'x' }])]);
    mkdirSync(join(claudeDir, SLUG, 'looks-like.jsonl'), { recursive: true });
    const result = await scanSessions({
      roots: { claudeProjectsDir: claudeDir, codexSessionsDir: codexDir },
    });
    expect(result.stats.requests).toBe(1);
    expect(result.stats.filesSkipped).toBe(0);
  });
});

describe('filters', () => {
  it('matches a workspace by slug, path, or fragment', () => {
    expect(workspaceMatches('-Users-me-proj', '-Users-me-proj')).toBe(true);
    expect(workspaceMatches('-Users-me-proj', '/Users/me/proj')).toBe(true);
    expect(workspaceMatches('-Users-me-proj', 'proj')).toBe(true);
    expect(workspaceMatches('-Users-me-proj', 'other')).toBe(false);
  });

  it('applies since inclusively and until exclusively', async () => {
    writeClaude('sess-a', [
      assistantLine('msg-1', [{ type: 'text', text: 'a' }], { ts: '2026-09-01T10:00:00.000Z' }),
      assistantLine('msg-2', [{ type: 'text', text: 'b' }], { ts: '2026-09-02T10:00:00.000Z' }),
      assistantLine('msg-3', [{ type: 'text', text: 'c' }], { ts: '2026-09-03T10:00:00.000Z' }),
    ]);
    const result = await scanSessions({
      roots: { claudeProjectsDir: claudeDir, codexSessionsDir: codexDir },
      filters: { since: '2026-09-02T00:00:00.000Z', until: '2026-09-03T00:00:00.000Z' },
    });
    expect(result.records.map((r) => r.requestId)).toEqual(['msg-2']);
  });

  it('drops undated requests once a time bound is set', async () => {
    const line = assistantLine('msg-1', [{ type: 'text', text: 'x' }]);
    delete line.timestamp;
    writeClaude('sess-a', [line]);
    const bounded = await scanSessions({
      roots: { claudeProjectsDir: claudeDir, codexSessionsDir: codexDir },
      filters: { since: '2026-01-01T00:00:00.000Z' },
    });
    expect(bounded.records).toHaveLength(0);
    const unbounded = await scanSessions({
      roots: { claudeProjectsDir: claudeDir, codexSessionsDir: codexDir },
    });
    expect(unbounded.records).toHaveLength(1);
  });

  it('matches a session by prefix and by sub-agent id', async () => {
    writeClaude('sess-abcdef', [assistantLine('msg-1', [{ type: 'text', text: 'x' }])]);
    writeSubagent('sess-parent', 'agent99', [assistantLine('msg-2', [{ type: 'text', text: 'y' }])]);

    const byPrefix = await scanSessions({
      roots: { claudeProjectsDir: claudeDir, codexSessionsDir: codexDir },
      filters: { session: 'sess-abc' },
    });
    expect(byPrefix.records).toHaveLength(1);
    expect(byPrefix.records[0]!.sessionId).toBe('sess-abcdef');

    const byAgent = await scanSessions({
      roots: { claudeProjectsDir: claudeDir, codexSessionsDir: codexDir },
      filters: { session: 'agent99' },
    });
    expect(byAgent.records).toHaveLength(1);
    expect(byAgent.records[0]!.agentId).toBe('agent99');
  });

  it('filters by engine', async () => {
    writeClaude('sess-a', [assistantLine('msg-1', [{ type: 'text', text: 'x' }])]);
    writeCodex('rollout-a.jsonl', [
      codexLine({ type: 'session_meta', payload: { id: 'cx-1', cwd: '/Users/me/proj' } }),
      codexLine({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 },
          },
        },
      }),
    ]);
    const result = await scanSessions({
      roots: { claudeProjectsDir: claudeDir, codexSessionsDir: codexDir },
      filters: { engine: 'codex' },
    });
    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.engine).toBe('codex');
  });
});

describe('aggregation', () => {
  async function twoRequests(): Promise<TurnRecord[]> {
    writeClaude('sess-a', [
      assistantLine('msg-1', [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: {} }], {
        usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 50 },
      }),
      assistantLine('msg-2', [{ type: 'tool_use', id: 'tu-2', name: 'Bash', input: {} }], {
        usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 150 },
      }),
    ]);
    return scan();
  }

  it('computes cache efficiency as cacheRead / prompt tokens', async () => {
    const agg = aggregate(await twoRequests());
    // 1800 cache read of 2000 prompt tokens.
    expect(agg.cacheEfficiency).toBeCloseTo(0.9, 6);
  });

  it('reports per-request output distribution', async () => {
    const agg = aggregate(await twoRequests());
    expect(agg.outputDistribution.count).toBe(2);
    expect(agg.outputDistribution.median).toBe(100);
    expect(agg.outputDistribution.max).toBe(150);
  });

  it('counts a tool once per request but every call', async () => {
    // Two Bash calls across two requests.
    const agg = aggregate(await twoRequests());
    const bash = agg.tools.find((t) => t.name === 'Bash');
    expect(bash?.calls).toBe(2);
    expect(bash?.requests).toBe(2);
  });

  it('merges one tool name seen through two engines into a single row', async () => {
    // claude-code's tool_use WebSearch and codex's web_search_call are one
    // tool to an operator; two identically-named rows would read as a bug.
    writeClaude('sess-a', [
      assistantLine('msg-1', [{ type: 'tool_use', id: 'tu-1', name: 'WebSearch', input: {} }]),
    ]);
    writeCodex('rollout-a.jsonl', [
      codexLine({ type: 'session_meta', payload: { id: 'cx-1', cwd: '/Users/me/proj' } }),
      codexLine({ type: 'response_item', payload: { type: 'web_search_call' } }),
      codexLine({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { last_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 } },
        },
      }),
    ]);

    const agg = aggregate(await scan());
    const search = agg.tools.filter((t) => t.name === 'WebSearch');
    expect(search).toHaveLength(1);
    expect(search[0]!.calls).toBe(2);
    expect(search[0]!.kinds).toEqual(['tool_use', 'web_search_call']);
  });

  it('sums the day table back to the totals', async () => {
    const records = await twoRequests();
    const agg = aggregate(records);
    const dayOutput = agg.byDay.reduce((n, d) => n + d.usage.output, 0);
    expect(dayOutput).toBe(agg.totals.usage.output);
  });

  it('gives undated requests their own day row rather than dropping them', async () => {
    const line = assistantLine('msg-1', [{ type: 'text', text: 'x' }]);
    delete line.timestamp;
    writeClaude('sess-a', [line]);
    const agg = aggregate(await scan());
    expect(agg.byDay.map((d) => d.key)).toEqual(['unknown']);
    expect(agg.totals.requests).toBe(1);
  });

  it('handles an empty record set', async () => {
    const agg = aggregate([]);
    expect(agg.totals.requests).toBe(0);
    expect(agg.cacheEfficiency).toBe(0);
    expect(agg.outputDistribution.median).toBe(0);
    expect(agg.byDay).toEqual([]);
  });
});

describe('report', () => {
  it('states the dedupe rule and the tool-attribution limit', async () => {
    writeClaude('sess-a', [
      assistantLine('msg-1', [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: {} }]),
    ]);
    const out = await runAnalyze({
      roots: { claudeProjectsDir: claudeDir, codexSessionsDir: codexDir },
    });
    expect(out.text).toContain('Dedupe.');
    expect(out.text).toContain('Token attribution to tools does not exist');
    expect(out.text).toContain('must not be summed across tools');
    // The report must not present a per-tool token total as consumption.
    expect(out.text).toContain('context, not consumption');
  });

  it('emits parseable JSON with --json', async () => {
    writeClaude('sess-a', [assistantLine('msg-1', [{ type: 'text', text: 'x' }])]);
    const out = await runAnalyze({
      roots: { claudeProjectsDir: claudeDir, codexSessionsDir: codexDir },
      json: true,
    });
    const parsed = JSON.parse(out.text) as { totals: { requests: number }; scan: unknown };
    expect(parsed.totals.requests).toBe(1);
    expect(parsed.scan).toBeDefined();
  });

  it('flags rolled-back codex sessions in the rendered output', async () => {
    writeCodex('rollout-a.jsonl', [
      codexLine({ type: 'session_meta', payload: { id: 'cx-roll', cwd: '/Users/me/proj' } }),
      codexLine({ type: 'event_msg', payload: { type: 'turn_aborted' } }),
      codexLine({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 },
          },
        },
      }),
    ]);
    const out = await runAnalyze({
      roots: { claudeProjectsDir: claudeDir, codexSessionsDir: codexDir },
    });
    expect(out.text).toContain('cx-roll');
    expect(out.text).toContain('rewound');
  });

  it('renders markdown without crashing on an empty scan', async () => {
    const out = await runAnalyze({
      roots: { claudeProjectsDir: join(root, 'none'), codexSessionsDir: join(root, 'none2') },
    });
    expect(out.text).toContain('# Session analytics');
    expect(out.text).toContain('_no data_');
  });

  it('renderMarkdown is stable for an empty record set', () => {
    const text = renderMarkdown(
      { records: [], stats: { filesScanned: 0, filesSkipped: 0, linesWithUsage: 0, requests: 0, collapseRatio: 1 }, warnings: [] },
      aggregate([]),
      {},
    );
    expect(text).toContain('Model requests | 0');
  });
});
