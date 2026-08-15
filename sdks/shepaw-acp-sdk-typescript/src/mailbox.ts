/**
 * Channel mailbox HTTP client (agent side).
 *
 * Pulls inbound sealed messages, deposits sealed replies (including stream
 * chunks for typewriter), acks processed items.
 * Auth: HMAC-SHA256(channel_secret, "{channel_id}\\n{agent_id}\\n{ts}\\n{nonce}").
 */

import { createHmac, randomBytes } from 'node:crypto';

/** Channel credentials for mailbox / grant-sync without owning a reverse tunnel. */
export interface ChannelMailboxConfig {
  serverUrl: string;
  channelId: string;
  secret: string;
}

export interface MailboxClientOptions extends ChannelMailboxConfig {
  agentId: string;
  onLog?: (line: string) => void;
}

export interface InboundMail {
  id: string;
  message_id: string;
  request_id?: string;
  session_id: string;
  group_id?: string;
  caller_fp: string;
  ciphertext: string;
  created_at: string;
}

export type MailboxReplyKind = 'chat' | 'stream' | 'article';

export class MailboxClient {
  private readonly base: string;
  private readonly channelId: string;
  private readonly secret: string;
  private readonly agentId: string;
  private readonly log: (line: string) => void;

  constructor(opts: MailboxClientOptions) {
    this.base = opts.serverUrl.replace(/\/+$/, '');
    this.channelId = opts.channelId;
    this.secret = opts.secret;
    this.agentId = opts.agentId;
    this.log = opts.onLog ?? ((line) => console.log(line));
  }

  async claimPending(limit = 5, messageId?: string): Promise<InboundMail[]> {
    const auth = this.signQuery();
    const extra =
      messageId !== undefined && messageId.length > 0
        ? `&message_id=${encodeURIComponent(messageId)}`
        : '';
    const url = `${this.base}/api/v1/mailbox/${encodeURIComponent(this.agentId)}/pending?limit=${limit}&${auth}${extra}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`claim pending HTTP ${resp.status}: ${body.slice(0, 120)}`);
    }
    const data = (await resp.json()) as { messages?: InboundMail[] };
    return data.messages ?? [];
  }

  async ackInbound(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const auth = this.signBody();
    const resp = await fetch(
      `${this.base}/api/v1/mailbox/${encodeURIComponent(this.agentId)}/ack`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids, ...auth }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      this.log(`[Mailbox] ack inbound failed: HTTP ${resp.status} ${body.slice(0, 120)}`);
    }
  }

  async depositReply(opts: {
    callerFp: string;
    replyTo: string;
    sessionId: string;
    messageId: string;
    requestId?: string;
    groupId?: string;
    kind?: MailboxReplyKind;
    ciphertext: string;
  }): Promise<void> {
    const auth = this.signBody();
    const resp = await fetch(
      `${this.base}/api/v1/mailbox/${encodeURIComponent(this.agentId)}/replies`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          caller_fp: opts.callerFp,
          reply_to: opts.replyTo,
          session_id: opts.sessionId,
          message_id: opts.messageId,
          request_id: opts.requestId,
          group_id: opts.groupId,
          kind: opts.kind ?? 'chat',
          ciphertext: opts.ciphertext,
          ...auth,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`deposit reply HTTP ${resp.status}: ${body.slice(0, 120)}`);
    }
  }

  private signQuery(): string {
    const { timestamp, nonce, signature } = this.sign();
    return `timestamp=${encodeURIComponent(timestamp)}&nonce=${encodeURIComponent(nonce)}&signature=${encodeURIComponent(signature)}`;
  }

  private signBody(): { timestamp: string; nonce: string; signature: string } {
    return this.sign();
  }

  private sign(): { timestamp: string; nonce: string; signature: string } {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomBytes(16).toString('hex');
    const signingString = `${this.channelId}\n${this.agentId}\n${timestamp}\n${nonce}`;
    const signature = createHmac('sha256', this.secret).update(signingString).digest('hex');
    return { timestamp, nonce, signature };
  }
}

/** Live mailbox stream sink: each text delta → sealed chunk in inbox. */
export interface MailboxStreamSink {
  readonly texts: string[];
  depositChunk(delta: string): Promise<void>;
  depositFinal(fullText: string): Promise<void>;
}

export function createMailboxStreamSink(opts: {
  client: MailboxClient;
  callerFp: string;
  replyTo: string;
  requestId: string;
  sessionId: string;
  groupId?: string;
  sealJson: (obj: unknown, pub: Uint8Array) => string;
  callerPublicKey: Uint8Array;
}): MailboxStreamSink {
  let seq = 0;
  const texts: string[] = [];
  let pending = '';
  let lastFlush = 0;
  let chain: Promise<void> = Promise.resolve();
  const FLUSH_MS = 400;
  const FLUSH_CHARS = 120;
  const { client, callerFp, replyTo, requestId, sessionId, groupId, sealJson, callerPublicKey } =
    opts;

  const flushPending = async (): Promise<void> => {
    if (!pending) return;
    const delta = pending;
    pending = '';
    lastFlush = Date.now();
    seq += 1;
    const ciphertext = sealJson(
      {
        kind: 'stream',
        reply_to: replyTo,
        request_id: requestId,
        session_id: sessionId,
        seq,
        delta,
        is_final: false,
        ts: Date.now(),
      },
      callerPublicKey,
    );
    await client.depositReply({
      callerFp,
      replyTo,
      sessionId,
      requestId,
      groupId,
      kind: 'stream',
      messageId: `${requestId}:chunk:${seq}`,
      ciphertext,
    });
  };

  const enqueue = (fn: () => Promise<void>): Promise<void> => {
    chain = chain.then(fn, fn);
    return chain;
  };

  return {
    texts,
    async depositChunk(delta: string): Promise<void> {
      if (!delta) return;
      texts.push(delta);
      pending += delta;
      const now = Date.now();
      if (pending.length >= FLUSH_CHARS || lastFlush === 0 || now - lastFlush >= FLUSH_MS) {
        await enqueue(flushPending);
      }
    },
    async depositFinal(fullText: string): Promise<void> {
      await enqueue(flushPending);
      const ciphertext = sealJson(
        {
          kind: 'chat',
          reply_to: replyTo,
          request_id: requestId,
          session_id: sessionId,
          content: fullText,
          is_final: true,
          ts: Date.now(),
        },
        callerPublicKey,
      );
      await client.depositReply({
        callerFp,
        replyTo,
        sessionId,
        requestId,
        groupId,
        kind: 'chat',
        messageId: `${requestId}:final`,
        ciphertext,
      });
    },
  };
}
