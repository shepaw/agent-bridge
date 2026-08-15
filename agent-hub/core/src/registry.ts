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
 *
 * After each successful register, approved/revoked access grants are pulled
 * and applied to that instance's `authorized_peers.json`.
 */

import { createHmac, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';

import { GrantSyncClient, loadOrCreateIdentity } from 'shepaw-acp-sdk';

import type { HubConfig, InstanceConfig } from './config.js';
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
  private readonly grantSyncByAgent = new Map<string, GrantSyncClient>();

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
    this.grantSyncByAgent.clear();
  }

  /** Register (heartbeat) every configured instance. Best-effort per instance. */
  async registerAll(): Promise<void> {
    const cfg = this.loadConfig();
    for (const instance of cfg.instances) {
      try {
        await this.registerInstance(instance);
      } catch (err) {
        this.log(`[Registry] Register ${instance.id} failed: ${formatErr(err)}`);
      }
    }
  }

  private async registerInstance(instance: InstanceConfig): Promise<void> {
    const instanceId = instance.id;
    const label = instance.label;
    const paths = instancePaths(instanceId);
    if (!existsSync(paths.identityPath)) return; // gateway hasn't generated identity yet

    const identity = loadOrCreateIdentity({ path: paths.identityPath });
    const agentPubKey = Buffer.from(identity.staticPublicKey).toString('base64');
    const runtime = await this.probeRuntime(instance);

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
        agent_pubkey: agentPubKey,
        name: label,
        path_prefix: `/p/${instanceId}/`,
        device_id: hostname(),
        capacity: runtime.capacity,
        active_count: runtime.activeCount,
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

    // Sync channel-mediated access grants into this instance's peers file.
    try {
      let sync = this.grantSyncByAgent.get(identity.agentId);
      if (sync === undefined) {
        sync = new GrantSyncClient({
          serverUrl: this.serverUrl,
          channelId: this.channelId,
          secret: this.secret,
          agentId: identity.agentId,
          peersPath: paths.peersPath,
          onLog: (line) => this.log(line),
        });
        this.grantSyncByAgent.set(identity.agentId, sync);
      }
      await sync.syncOnce();
    } catch (err) {
      this.log(`[Registry] Grant sync ${identity.agentId} failed: ${formatErr(err)}`);
    }
  }

  private async probeRuntime(
    instance: InstanceConfig,
  ): Promise<{ activeCount: number; capacity: number }> {
    const host = instance.host === '0.0.0.0' || instance.host === '::' || instance.host === ''
      ? '127.0.0.1'
      : instance.host;
    try {
      const resp = await fetch(`http://${host}:${instance.port}/status`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (!resp.ok) return { activeCount: 0, capacity: 5 };
      const data = (await resp.json()) as {
        runtime?: { activeTasks?: number; capacity?: number };
      };
      const activeCount = Number(data.runtime?.activeTasks) || 0;
      const capacity = Number(data.runtime?.capacity);
      return {
        activeCount,
        capacity: Number.isFinite(capacity) && capacity >= 0 ? capacity : 5,
      };
    } catch {
      return { activeCount: 0, capacity: 5 };
    }
  }
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
