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

/** Skip synthetic user turns that are really tool-output notifications. */
function isSyntheticUserTurn(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('<task-notification>') || t.startsWith('<system-');
}

export async function loadUpstreamSessionTranscript(
  spec: AcpEngineSpec,
  cwd: string,
  sessionId: string,
  env?: Record<string, string | undefined>,
  opts: { idleMs?: number; maxMs?: number } = {},
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

  // Ordered turns, grouping consecutive chunks that share a messageId.
  const turns: SessionHistoryMessage[] = [];
  let lastUpdateAt = Date.now();
  const onChunk = (role: 'user' | 'agent', messageId: string | undefined, text: string): void => {
    lastUpdateAt = Date.now();
    const last = turns[turns.length - 1];
    if (last !== undefined && last.role === role && messageId !== undefined && last.message_id === messageId) {
      last.content += text;
      return;
    }
    turns.push({ role, content: text, message_id: messageId });
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
      if (update.sessionUpdate === 'user_message_chunk' || update.sessionUpdate === 'agent_message_chunk') {
        const content = update.content;
        if (content?.type !== 'text') { lastUpdateAt = Date.now(); return; }
        const role = update.sessionUpdate === 'user_message_chunk' ? 'user' : 'agent';
        onChunk(role, update.messageId, content.text);
      } else {
        lastUpdateAt = Date.now();
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

  return turns
    .filter((t) => t.content.trim().length > 0)
    .filter((t) => !(t.role === 'user' && isSyntheticUserTurn(t.content)));
}
