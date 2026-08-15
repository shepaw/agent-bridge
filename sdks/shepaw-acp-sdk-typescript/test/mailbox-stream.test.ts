import { describe, expect, it } from 'vitest';

import type { MailboxClient, MailboxStreamSink } from '../src/mailbox.js';
import { createMailboxStreamSink } from '../src/mailbox.js';
import { TaskContext } from '../src/task-context.js';
import type { WebSocket } from 'ws';

function stubWs(): WebSocket {
  return { readyState: 3 } as unknown as WebSocket;
}

function collectingSink(): MailboxStreamSink {
  const texts: string[] = [];
  return {
    texts,
    async depositChunk(delta: string): Promise<void> {
      if (!delta) return;
      texts.push(delta);
    },
    async depositFinal(): Promise<void> {},
  };
}

function mailboxContext(sink: MailboxStreamSink): TaskContext {
  return new TaskContext({
    ws: stubWs(),
    taskId: 'mailbox_t1',
    sessionId: 's1',
    pendingHubRequests: new Map(),
    pendingResponses: new Map(),
    mailboxStream: sink,
  });
}

describe('mailbox stream collectedText', () => {
  it('does not duplicate deltas when sendText goes through depositChunk', async () => {
    const sink = collectingSink();
    const ctx = mailboxContext(sink);

    await ctx.sendText('你好');
    await ctx.sendText('世界');

    expect(ctx.collectedText).toBe('你好世界');
    expect(sink.texts).toEqual(['你好', '世界']);
  });

  it('skips empty deltas the same way depositChunk does', async () => {
    const sink = collectingSink();
    const ctx = mailboxContext(sink);

    await ctx.sendText('');
    await ctx.sendText('ok');

    expect(ctx.collectedText).toBe('ok');
  });

  it('degrades action confirmation to text in mailbox mode', async () => {
    const sink = collectingSink();
    const ctx = mailboxContext(sink);

    await ctx.sendActionConfirmation({
      prompt: '允许执行 rm -rf /tmp/x 吗？',
      actions: [
        { label: '允许', value: 'allow' },
        { label: '拒绝', value: 'deny' },
      ],
    });

    expect(ctx.collectedText).toContain('需要确认');
    expect(ctx.collectedText).toContain('允许执行 rm -rf /tmp/x 吗？');
    expect(ctx.collectedText).toContain('允许 / 拒绝');
  });
});

describe('createMailboxStreamSink coalescing', () => {
  it('merges trailing small deltas into one stream deposit', async () => {
    const deposits: Array<{ messageId: string; kind?: string }> = [];
    const fake = {
      async depositReply(opts: { messageId: string; kind?: string }) {
        deposits.push({ messageId: opts.messageId, kind: opts.kind });
      },
    } as unknown as MailboxClient;

    const sink = createMailboxStreamSink({
      client: fake,
      callerFp: 'abcdabcdabcdabcd',
      replyTo: 'msg1',
      requestId: 'req1',
      sessionId: 's1',
      sealJson: () => 'sealed',
      callerPublicKey: new Uint8Array(32),
    });

    await sink.depositChunk('hello');
    await sink.depositChunk(' ');
    await sink.depositChunk('world');
    await sink.depositFinal('hello world');

    expect(sink.texts).toEqual(['hello', ' ', 'world']);
    expect(deposits.map((d) => d.messageId)).toEqual([
      'req1:chunk:1',
      'req1:chunk:2',
      'req1:final',
    ]);
  });
});
