/**
 * Channel-side agent registry reporter (hub mode).
 *
 * The device-level tunnel router fronts every managed instance over a single
 * channel, so per-agent registration can't ride the tunnel handshake (that
 * carries at most one identity). Instead, for each hub instance this module
 * POSTs ` /api/v1/agents/register` to the Channel Service, signed with the
 * channel secret:
 *
 *   signing_string = "{channel_id}\n{agent_id}\n{timestamp}\n{nonce}"
 *   signature      = HMAC-SHA256(channel_secret, signing_string)
 *
 * Registration is idempotent on the server and doubles as a heartbeat:
 * re-registering refreshes `last_seen_at`, which is what the channel
 * dashboard uses for the online indicator. Failures are logged and swallowed
 * — registry reporting must never take down traffic routing.
 */

import { createHmac, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';

import { loadOrCreateIdentity } from 'shepaw-acp-sdk';

import type { HubConfig } from './config.js';
import { loadOrCreateHubConfig } from './config.js';
import { instancePaths } from './paths.js';

export interface AgentRegistryOptions {
  /** Channel Service base URL, e.g. `https://channel.example.com`. */
  serverUrl: string;
  channelId: string;
  /** Channel secret (`ch_sec_…`); never leaves the device, only HMACs travel. */
  secret: string;
  /** Config loader; injectable for tests. Defaults to on-disk hub config. */
  loadConfig?: () => HubConfig;
  onLog?: (line: string) => void;
}

export class AgentRegistry {
  private readonly serverUrl: string;
  private readonly channelId: string;
  private readonly secret: string;
  private readonly loadConfig: () => HubConfig;
  private readonly log: (line: string) => void;

  private timer: NodeJS.Timeout | undefined;

  constructor(opts: AgentRegistryOptions) {
    this.serverUrl = opts.serverUrl.replace(/\/+$/, '');
    this.channelId = opts.channelId;
    this.secret = opts.secret;
    this.loadConfig = opts.loadConfig ?? (() => loadOrCreateHubConfig());
    this.log = opts.onLog ?? ((line) => console.log(line));
  }

  /** Register all instances now, then keep re-registering on an interval. */
  start(intervalMs = 120_000): void {
    void this.registerAll();
    this.timer = setInterval(() => void this.registerAll(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Register (heartbeat) every configured instance. Best-effort per instance. */
  async registerAll(): Promise<void> {
    const cfg = this.loadConfig();
    for (const instance of cfg.instances) {
      try {
        await this.registerInstance(instance.id, instance.label);
      } catch (err) {
        this.log(`[Registry] Register ${instance.id} failed: ${formatErr(err)}`);
      }
    }
  }

  private async registerInstance(instanceId: string, label: string): Promise<void> {
    const idPath = instancePaths(instanceId).identityPath;
    if (!existsSync(idPath)) return; // gateway hasn't generated identity yet

    const identity = loadOrCreateIdentity({ path: idPath });

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomBytes(16).toString('hex');
    const signingString = `${this.channelId}\n${identity.agentId}\n${timestamp}\n${nonce}`;
    const signature = createHmac('sha256', this.secret).update(signingString).digest('hex');

    const resp = await fetch(`${this.serverUrl}/api/v1/agents/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        channel_id: this.channelId,
        agent_id: identity.agentId,
        agent_fp: identity.fingerprint,
        name: label,
        path_prefix: `/p/${instanceId}/`,
        device_id: hostname(),
        timestamp,
        nonce,
        signature,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      this.log(`[Registry] ${identity.agentId} → HTTP ${resp.status} ${body.slice(0, 120)}`);
      return;
    }
    this.log(`[Registry] ${identity.agentId} (${label}) registered`);
  }
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
