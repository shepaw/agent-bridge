/**
 * Ephemeral ACP connection to replay an upstream session's transcript.
 *
 * `session/load` makes the agent replay the whole conversation as
 * `session/update` notifications (user/agent message chunks, thoughts, tool
 * calls). We spawn a throwaway subprocess, load the session, capture the
 * user/agent text turns (grouped by messageId), and return them oldest→newest.
 * Using a throwaway process keeps the live serving subprocess untouched.
 */

import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';

import * as acp from '@agentclientprotocol/sdk';
import type { SessionHistoryMessage } from 'shepaw-acp-sdk';

import type { AcpEngineSpec } from './engines.js';
import { spawnCommand } from './engines.js';
import { extractEmbeddedTimestamp } from './transcript-timestamp.js';
import { ensureHistoryCreatedAt } from './history-created-at.js';
import { formatPlanText, formatToolCallUpdateText } from './permission/format.js';

/** Skip synthetic user turns that are really tool-output notifications. */
function isSyntheticUserTurn(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('<task-notification>') || t.startsWith('<system-');
}

/**
 * Groups replayed `session/update` text chunks into logical turns.
 *
 * The app renders each history message as its own bubble, so the grouping must
 * match the live stream (one bubble per reply):
 *  - role change → new turn;
 *  - same role + same/unknown messageId → raw concat (chunks are arbitrary
 *    token splits and must rejoin without separators);
 *  - same role + a new defined messageId → same bubble, but keep the paragraph
 *    boundary (these are distinct answer segments split by dropped tool calls).
 */
export class ReplayTurnCollector {
  readonly turns: SessionHistoryMessage[] = [];
  private currentSegmentMessageId: string | undefined;
  /** What the last progress segment was, so thought runs rejoin cleanly. */
  private lastProgressKind: 'thought' | 'tool' | 'plan' | undefined;

  pushChunk(role: 'user' | 'agent', messageId: string | undefined, text: string): void {
    const last = this.turns[this.turns.length - 1];
    if (last !== undefined && last.role === role) {
      if (
        messageId !== undefined &&
        this.currentSegmentMessageId !== undefined &&
        messageId !== this.currentSegmentMessageId
      ) {
        last.content = `${last.content}\n\n${text}`;
      } else {
        last.content += text;
      }
      if (messageId !== undefined) {
        this.currentSegmentMessageId = messageId;
        if (last.message_id === undefined) last.message_id = messageId;
      }
      return;
    }

    this.currentSegmentMessageId = messageId;
    this.lastProgressKind = undefined;
    // Engine-specific enrichment → standard `created_at` (see transcript-timestamp).
    const extracted = role === 'user' ? extractEmbeddedTimestamp(text) : { text };
    const turn: SessionHistoryMessage = {
      role,
      content: extracted.text,
      message_id: messageId,
    };
    if (extracted.createdAt !== undefined) {
      turn.created_at = extracted.createdAt;
    }
    this.turns.push(turn);
  }

  /** Agent thinking chunks — raw-concat within a run, like the live stream. */
  pushThought(text: string): void {
    if (text.length === 0) return;
    const turn = this.agentTurn();
    if (this.lastProgressKind === 'thought' && turn.progress_content !== undefined) {
      turn.progress_content += text;
    } else {
      this.appendProgress(turn, text);
    }
    this.lastProgressKind = 'thought';
    turn.progress_title = 'Thinking';
    turn.progress_auto_collapse = true;
  }

  /** `tool_call` / `tool_call_update` — same text the live bubble shows. */
  pushToolUpdate(update: acp.SessionUpdate): void {
    const text = formatToolCallUpdateText(update);
    if (text === undefined) return;
    const turn = this.agentTurn();
    this.appendProgress(turn, text.trimEnd());
    this.lastProgressKind = 'tool';
    const title =
      (update as { title?: string; kind?: string; toolCallId?: string }).title ??
      (update as { kind?: string }).kind ??
      'Tool';
    turn.progress_title = title;
    turn.progress_auto_collapse = true;
  }

  /** `plan` — numbered list, section stays expanded like the live bubble. */
  pushPlan(update: acp.SessionUpdate): void {
    const text = formatPlanText(update);
    if (text === undefined) return;
    const turn = this.agentTurn();
    this.appendProgress(turn, text.trimEnd());
    this.lastProgressKind = 'plan';
    turn.progress_title = 'Plan';
    turn.progress_auto_collapse = false;
  }

  /** Progress belongs to the in-flight agent reply; create it if needed. */
  private agentTurn(): SessionHistoryMessage {
    const last = this.turns[this.turns.length - 1];
    if (last !== undefined && last.role === 'agent') return last;
    const turn: SessionHistoryMessage = { role: 'agent', content: '' };
    this.turns.push(turn);
    this.currentSegmentMessageId = undefined;
    return turn;
  }

  private appendProgress(turn: SessionHistoryMessage, text: string): void {
    turn.progress_content =
      turn.progress_content !== undefined && turn.progress_content.length > 0
        ? `${turn.progress_content}\n${text}`
        : text;
  }
}

export async function loadUpstreamSessionTranscript(
  spec: AcpEngineSpec,
  cwd: string,
  sessionId: string,
  env?: Record<string, string | undefined>,
  opts: { idleMs?: number; maxMs?: number; sessionUpdatedAt?: string } = {},
): Promise<SessionHistoryMessage[]> {
  const idleMs = opts.idleMs ?? 400;
  const maxMs = opts.maxMs ?? 30_000;

  const { command, args } = spawnCommand(spec);
  const child = spawn(command, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  if (child.stdin === null || child.stdout === null) {
    throw new Error('ACP agent subprocess missing stdin/stdout pipes');
  }

  // Ordered turns, grouping consecutive chunks into one bubble per reply.
  const collector = new ReplayTurnCollector();
  let lastUpdateAt = Date.now();
  const onChunk = (role: 'user' | 'agent', messageId: string | undefined, text: string): void => {
    lastUpdateAt = Date.now();
    collector.pushChunk(role, messageId, text);
  };

  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  const connection = acp
    .client({ name: 'shepaw-acp-proxy' })
    .onRequest(acp.methods.client.fs.readTextFile, async () => ({ content: '' }))
    .onRequest(acp.methods.client.fs.writeTextFile, async () => ({}))
    .onNotification(acp.methods.client.session.update, async (arg) => {
      const a = arg as { update?: acp.SessionUpdate; params?: { update?: acp.SessionUpdate } };
      const update = a?.update ?? a?.params?.update;
      if (update === undefined) return;
      lastUpdateAt = Date.now();
      switch (update.sessionUpdate) {
        case 'user_message_chunk':
        case 'agent_message_chunk': {
          const content = update.content;
          if (content?.type !== 'text') return;
          const role = update.sessionUpdate === 'user_message_chunk' ? 'user' : 'agent';
          onChunk(role, update.messageId ?? undefined, content.text);
          return;
        }
        case 'agent_thought_chunk': {
          const content = update.content;
          if (content?.type === 'text') collector.pushThought(content.text);
          return;
        }
        case 'tool_call':
        case 'tool_call_update':
          collector.pushToolUpdate(update);
          return;
        case 'plan':
          collector.pushPlan(update);
          return;
        default:
          return;
      }
    })
    .connect(stream);

  try {
    await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      clientInfo: { name: 'shepaw-acp-proxy', title: 'Shepaw ACP Proxy', version: '0.2.0' },
    });

    // session/load streams the replay as notifications while this resolves.
    await connection.agent.request(acp.methods.agent.session.load, {
      sessionId,
      cwd,
      mcpServers: [],
    });

    // Wait for replay to go idle (some agents flush a few updates after the
    // load response resolves).
    const startedAt = Date.now();
    while (Date.now() - startedAt < maxMs) {
      if (Date.now() - lastUpdateAt >= idleMs) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    connection.close();
    if (!child.killed) child.kill('SIGTERM');
  }

  const filtered = collector.turns
    // Keep progress-only turns: an interrupted reply may be all tool calls.
    .filter((t) => t.content.trim().length > 0 || (t.progress_content?.trim().length ?? 0) > 0)
    .filter((t) => !(t.role === 'user' && isSyntheticUserTurn(t.content)));

  // Always emit protocol `created_at` so clients never need engine adapters.
  return ensureHistoryCreatedAt(filtered, { sessionUpdatedAt: opts.sessionUpdatedAt });
}
