/**
 * Pull approved/revoked access grants from Channel and apply to
 * `authorized_peers.json`. Channel is only the mediator — Noise still gates
 * on the local allowlist.
 */

import { createHmac, randomBytes } from 'node:crypto';

import { addPeer, removePeerByFingerprint } from './peers.js';

export interface GrantSyncOptions {
  serverUrl: string;
  channelId: string;
  secret: string;
  agentId: string;
  peersPath: string;
  onLog?: (line: string) => void;
}

interface RemoteGrant {
  id: string;
  caller_fp: string;
  caller_pubkey: string;
  caller_name?: string;
  status: 'approved' | 'revoked' | string;
  updated_at: string;
}

export class GrantSyncClient {
  private readonly base: string;
  private readonly channelId: string;
  private readonly secret: string;
  private readonly agentId: string;
  private readonly peersPath: string;
  private readonly log: (line: string) => void;
  private since: string | undefined;

  constructor(opts: GrantSyncOptions) {
    this.base = opts.serverUrl.replace(/\/+$/, '');
    this.channelId = opts.channelId;
    this.secret = opts.secret;
    this.agentId = opts.agentId;
    this.peersPath = opts.peersPath;
    this.log = opts.onLog ?? ((line) => console.log(line));
  }

  /** Fetch grants changed since last sync and apply add/remove. */
  async syncOnce(): Promise<void> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomBytes(16).toString('hex');
    const signingString = `${this.channelId}\n${this.agentId}\n${timestamp}\n${nonce}`;
    const signature = createHmac('sha256', this.secret).update(signingString).digest('hex');

    const params = new URLSearchParams({
      timestamp,
      nonce,
      signature,
    });
    if (this.since !== undefined) params.set('since', this.since);

    const url = `${this.base}/api/v1/agents/${encodeURIComponent(this.agentId)}/grants?${params}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`grants HTTP ${resp.status}: ${body.slice(0, 120)}`);
    }
    const data = (await resp.json()) as { grants?: RemoteGrant[] };
    const grants = data.grants ?? [];
    let latest = this.since;

    for (const g of grants) {
      try {
        if (g.status === 'approved') {
          addPeer(this.peersPath, g.caller_pubkey, g.caller_name || `grant:${g.caller_fp}`);
          this.log(`[GrantSync] approved ${g.caller_fp} → peers`);
        } else if (g.status === 'revoked') {
          removePeerByFingerprint(this.peersPath, g.caller_fp);
          this.log(`[GrantSync] revoked ${g.caller_fp} ← peers`);
        }
        if (latest === undefined || g.updated_at > latest) {
          latest = g.updated_at;
        }
      } catch (err) {
        this.log(
          `[GrantSync] apply ${g.status} ${g.caller_fp} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (latest !== undefined) this.since = latest;
  }
}
