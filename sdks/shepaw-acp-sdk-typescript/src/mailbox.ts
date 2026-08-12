/**
 * Channel mailbox HTTP client (agent side).
 *
 * Pulls inbound sealed messages, deposits sealed replies, acks processed
 * items. Auth: HMAC-SHA256(channel_secret, "{channel_id}\\n{agent_id}\\n{ts}\\n{nonce}").
 */

import { createHmac, randomBytes } from 'node:crypto';

export interface MailboxClientOptions {
  serverUrl: string;
  channelId: string;
  secret: string;
  agentId: string;
  onLog?: (line: string) => void;
}

export interface InboundMail {
  id: string;
  message_id: string;
  session_id: string;
  caller_fp: string;
  ciphertext: string;
  created_at: string;
}

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

  async claimPending(limit = 5): Promise<InboundMail[]> {
    const auth = this.signQuery();
    const url = `${this.base}/api/v1/mailbox/${encodeURIComponent(this.agentId)}/pending?limit=${limit}&${auth}`;
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
    messageId?: string;
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
