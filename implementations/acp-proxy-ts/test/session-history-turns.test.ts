/**
 * Regression tests for "one reply splits into many bubbles after sync" on the
 * `session/load` replay path: chunks must coalesce into one turn per reply.
 */

import { describe, expect, it } from 'vitest';

import { ReplayTurnCollector } from '../src/session-history.js';

describe('ReplayTurnCollector', () => {
  it('joins streaming chunks of one message without separators', () => {
    const c = new ReplayTurnCollector();
    c.pushChunk('agent', 'm1', 'Hel');
    c.pushChunk('agent', 'm1', 'lo, ');
    c.pushChunk('agent', 'm1', 'world');
    expect(c.turns).toEqual([{ role: 'agent', content: 'Hello, world', message_id: 'm1' }]);
  });

  it('coalesces chunks with missing messageId instead of one turn per chunk', () => {
    // Regression: engines that replay without messageId used to produce one
    // history message per chunk — the app showed dozens of bubbles per reply.
    const c = new ReplayTurnCollector();
    c.pushChunk('agent', undefined, 'part one. ');
    c.pushChunk('agent', undefined, 'part two.');
    expect(c.turns).toHaveLength(1);
    expect(c.turns[0]).toMatchObject({ role: 'agent', content: 'part one. part two.' });
  });

  it('keeps a paragraph boundary between distinct same-role messages in one turn', () => {
    const c = new ReplayTurnCollector();
    c.pushChunk('agent', 'm1', 'first segment');
    c.pushChunk('agent', 'm2', 'second segment');
    c.pushChunk('agent', 'm2', ' continues');
    expect(c.turns).toHaveLength(1);
    expect(c.turns[0].content).toBe('first segment\n\nsecond segment continues');
    expect(c.turns[0].message_id).toBe('m1');
  });

  it('starts a new turn on role change', () => {
    const c = new ReplayTurnCollector();
    c.pushChunk('user', 'u1', 'question');
    c.pushChunk('agent', 'a1', 'answer');
    c.pushChunk('user', 'u2', 'follow-up');
    expect(c.turns.map((t) => t.role)).toEqual(['user', 'agent', 'user']);
  });

  it('backfills message_id when only later chunks carry it', () => {
    const c = new ReplayTurnCollector();
    c.pushChunk('agent', undefined, 'chunk ');
    c.pushChunk('agent', 'm9', 'tail');
    expect(c.turns).toHaveLength(1);
    expect(c.turns[0].message_id).toBe('m9');
  });

  it('collects thinking/tool/plan into the progress section like the live stream', () => {
    const c = new ReplayTurnCollector();
    c.pushChunk('user', 'u1', 'run ls');
    c.pushThought('User wants a listing.');
    c.pushToolUpdate({
      sessionUpdate: 'tool_call',
      title: 'Bash',
      status: 'completed',
      rawInput: { command: 'ls -la' },
    } as never);
    c.pushChunk('agent', 'a1', 'Here is the listing.');

    expect(c.turns).toHaveLength(2);
    const agent = c.turns[1];
    expect(agent.content).toBe('Here is the listing.');
    expect(agent.progress_content).toBe(
      'User wants a listing.\n[completed] Bash\n```\nls -la\n```',
    );
    expect(agent.progress_title).toBe('Bash');
    expect(agent.progress_auto_collapse).toBe(true);
  });

  it('keeps a progress-only turn (interrupted reply with just tool calls)', () => {
    const c = new ReplayTurnCollector();
    c.pushChunk('user', 'u1', 'go');
    c.pushToolUpdate({
      sessionUpdate: 'tool_call',
      title: 'Bash',
      status: 'completed',
      rawInput: { command: 'make' },
    } as never);
    const agent = c.turns[1];
    expect(agent.role).toBe('agent');
    expect(agent.content).toBe('');
    expect(agent.progress_content).toBe('[completed] Bash\n```\nmake\n```');
  });

  it('plan sections stay expanded (auto_collapse=false)', () => {
    const c = new ReplayTurnCollector();
    c.pushPlan({
      sessionUpdate: 'plan',
      entries: [{ content: 'step one' }, { content: 'step two' }],
    } as never);
    const agent = c.turns[0];
    expect(agent.progress_content).toBe('1. step one\n2. step two');
    expect(agent.progress_title).toBe('Plan');
    expect(agent.progress_auto_collapse).toBe(false);
  });

  it('consecutive thought chunks rejoin without separators', () => {
    const c = new ReplayTurnCollector();
    c.pushThought('think');
    c.pushThought('ing aloud');
    expect(c.turns[0].progress_content).toBe('thinking aloud');
  });
});
