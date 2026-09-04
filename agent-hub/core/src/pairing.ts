/**
 * Hub-level device pairing — one QR scan authorizes a Shepaw app on every
 * managed agent (instance) on this host.
 *
 * Flow (matches shepaw://pair in the Shepaw app):
 *   1. Operator mints a hub enrollment token (`shepaw-hub gateway pair`).
 *   2. QR encodes bootstrap agent WS URL + one-time code.
 *   3. App scans, completes Noise handshake on the bootstrap gateway.
 *   4. Gateway fan-out hook adds the device pubkey to every instance's peers file
 *      and clears the shared token from all enrollment stores.
 *   5. App can add other agents from the catalog using their WS URLs (no code).
 */

import { loadOrCreateIdentity } from 'shepaw-acp-sdk';
import {
  addPeer,
  createEnrollmentToken,
  formatCodeForDisplay,
  loadOrCreateEnrollments,
  loadOrCreatePeers,
  removeEnrollmentTokenByCode,
  removePeerByFingerprint,
  syncEnrollmentToken,
  type EnrollmentToken,
} from 'shepaw-acp-sdk';

import type { HubConfig, InstanceConfig } from './config.js';
import { loadOrCreateHubConfig } from './config.js';
import { gatewayAcpWsBase } from './gateway-endpoints.js';
import { hubEnrollmentsPath, instancePaths } from './paths.js';
import { ensureInstanceDir, isAlive, readState } from './spawn.js';
import { resolvePublicHost } from './network.js';
import { hubStoreDeviceId, workspaceStoreUri } from './peer/agent-store-mapping.js';

export interface HubAgentCatalogEntry {
  instanceId: string;
  label: string;
  engine: string;
  agentId: string;
  fingerprint: string;
  /** Base64-encoded X25519 public key (Noise IK). */
  publicKey: string;
  /** WebSocket URL for direct connect (includes #fp=&pk=). */
  wsUrl: string;
  host: string;
  port: number;
  running: boolean;
  /** Mapped store://workspaces URI for this instance's working directory. */
  workspaceUri?: string;
  /** Primary + additional workspace roots when more than one is configured. */
  workspaceUris?: string[];
}

export interface HubPairingResult {
  code: string;
  display: string;
  label: string;
  expiresAt: string;
  createdAt: string;
  /** Bootstrap instance used in the QR (first online, else first registered). */
  bootstrapInstanceId: string;
  pairUrl: string;
  qrPayload: string;
  agents: HubAgentCatalogEntry[];
}

export interface HubPairedDevice {
  fingerprint: string;
  label: string;
  /** Instance ids where this device is authorized. */
  instanceIds: string[];
  addedAt: string | null;
}

export interface CreateHubPairingOptions {
  label?: string;
  ttlMs?: number;
  /** Override bootstrap instance for the QR WS URL. */
  bootstrapInstanceId?: string;
  /** Override public WS base for bootstrap (tunnel URL). */
  baseUrl?: string;
}

export interface FanOutPeerOptions {
  publicKeyB64: string;
  label: string;
  enrollmentCode: string;
}

function buildWsPairUrl(
  instance: InstanceConfig,
  identity: { agentId: string; fingerprint: string; staticPublicKey: Uint8Array },
  opts: { baseUrl?: string; gatewayBase?: string } = {},
): string {
  const pkEncoded = encodeURIComponent(
    Buffer.from(identity.staticPublicKey).toString('base64'),
  );
  const fragment = `fp=${identity.fingerprint}&pk=${pkEncoded}`;

  // 1. Explicit --base-url override wins (LAN pairing, custom relays).
  if (opts.baseUrl !== undefined && opts.baseUrl.length > 0) {
    const resolvedBase = opts.baseUrl.replace(/\/$/, '');
    return `${resolvedBase}/acp/ws?agentId=${identity.agentId}#${fragment}`;
  }

  // 2. Shared gateway channel: one channel fronts every agent, routed by the
  //    `/p/<instanceId>` prefix the tunnel router dispatches on.
  if (opts.gatewayBase !== undefined && opts.gatewayBase.length > 0) {
    return `${opts.gatewayBase}/p/${encodeURIComponent(instance.id)}/acp/ws?agentId=${identity.agentId}#${fragment}`;
  }

  // 3. Legacy per-instance base URL (deprecated per-agent tunnel).
  const resolvedBase = instance.baseUrl.replace(/\/$/, '');
  if (resolvedBase.length > 0) {
    return `${resolvedBase}/acp/ws?agentId=${identity.agentId}#${fragment}`;
  }

  // 4. Loopback / LAN fallback.
  const host = resolvePublicHost(instance.host);
  return `ws://${host}:${instance.port}/acp/ws?agentId=${identity.agentId}#${fragment}`;
}

function isInstanceRunning(instanceId: string): boolean {
  const state = readState(instancePaths(instanceId).statePath);
  return state !== undefined && state.pid > 0 && isAlive(state.pid);
}

function pickBootstrapInstance(cfg: HubConfig, preferredId?: string): InstanceConfig {
  if (cfg.instances.length === 0) {
    throw new Error('No instances registered. Add a instance before pairing a device.');
  }
  if (preferredId !== undefined) {
    const found = cfg.instances.find((p) => p.id === preferredId);
    if (found === undefined) {
      throw new Error(`Unknown bootstrap instance "${preferredId}".`);
    }
    return found;
  }
  const online = cfg.instances.find((p) => isInstanceRunning(p.id));
  return online ?? cfg.instances[0]!;
}

/** List every managed agent with connection metadata for the Shepaw app. */
export function listHubAgentCatalog(cfg: HubConfig = loadOrCreateHubConfig()): HubAgentCatalogEntry[] {
  const gatewayBase = gatewayAcpWsBase(cfg);
  let workspaceDeviceId: string | undefined;
  try {
    workspaceDeviceId = hubStoreDeviceId();
  } catch {
    workspaceDeviceId = undefined;
  }
  return cfg.instances.map((instance) => {
    const paths = instancePaths(instance.id);
    ensureInstanceDir(instance.id);
    const identity = loadOrCreateIdentity({ path: paths.identityPath });
    return {
      instanceId: instance.id,
      label: instance.label,
      engine: instance.engine,
      agentId: identity.agentId,
      fingerprint: identity.fingerprint,
      publicKey: Buffer.from(identity.staticPublicKey).toString('base64'),
      wsUrl: buildWsPairUrl(instance, identity, { gatewayBase }),
      host: instance.host,
      port: instance.port,
      running: isInstanceRunning(instance.id),
      ...(workspaceDeviceId !== undefined
        ? {
            workspaceUri: workspaceStoreUri(workspaceDeviceId, instance.cwd),
            ...(instance.additionalDirectories !== undefined
              && instance.additionalDirectories.length > 0
              ? {
                  workspaceUris: [
                    workspaceStoreUri(workspaceDeviceId, instance.cwd),
                    ...instance.additionalDirectories.map((d) =>
                      workspaceStoreUri(workspaceDeviceId, d),
                    ),
                  ],
                }
              : {}),
          }
        : {}),
    };
  });
}

/** Newline-separated peer/enrollment paths for gateway fan-out env vars. */
export function hubFanoutEnvPaths(cfg: HubConfig = loadOrCreateHubConfig()): {
  peerPaths: string;
  enrollmentPaths: string;
} {
  const peerPaths = cfg.instances.map((p) => instancePaths(p.id).peersPath);
  const enrollmentPaths = [hubEnrollmentsPath(), ...cfg.instances.map((p) => instancePaths(p.id).enrollmentsPath)];
  return {
    peerPaths: peerPaths.join('\n'),
    enrollmentPaths: enrollmentPaths.join('\n'),
  };
}

/** Mint a hub-wide enrollment token replicated to every instance. */
export function createHubPairing(opts: CreateHubPairingOptions = {}): HubPairingResult {
  const cfg = loadOrCreateHubConfig();
  const bootstrap = pickBootstrapInstance(cfg, opts.bootstrapInstanceId);
  const ttlMs = opts.ttlMs ?? 10 * 60 * 1000;
  const label = opts.label ?? 'Shepaw device';

  for (const instance of cfg.instances) {
    ensureInstanceDir(instance.id);
  }

  const hubPath = hubEnrollmentsPath();
  const token = createEnrollmentToken(hubPath, { label, ttlMs });

  for (const instance of cfg.instances) {
    syncEnrollmentToken(instancePaths(instance.id).enrollmentsPath, token);
  }

  const bootstrapIdentity = loadOrCreateIdentity({ path: instancePaths(bootstrap.id).identityPath });
  const gatewayBase = gatewayAcpWsBase(cfg);
  const pairUrl = buildWsPairUrl(bootstrap, bootstrapIdentity, { baseUrl: opts.baseUrl, gatewayBase });
  const qrPayload = `shepaw://pair?url=${encodeURIComponent(pairUrl)}&code=${encodeURIComponent(token.code)}`;

  return {
    code: token.code,
    display: formatCodeForDisplay(token.code),
    label: token.label,
    expiresAt: token.expiresAt,
    createdAt: token.createdAt,
    bootstrapInstanceId: bootstrap.id,
    pairUrl,
    qrPayload,
    agents: listHubAgentCatalog(cfg),
  };
}

/** After bootstrap handshake, authorize the device on every instance. */
export function fanOutHubPeer(opts: FanOutPeerOptions, cfg: HubConfig = loadOrCreateHubConfig()): void {
  const { publicKeyB64, label, enrollmentCode } = opts;

  for (const instance of cfg.instances) {
    const paths = instancePaths(instance.id);
    try {
      addPeer(paths.peersPath, publicKeyB64, label);
    } catch (err) {
      throw new Error(
        `Failed to authorize peer on instance "${instance.id}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  removeEnrollmentTokenByCode(hubEnrollmentsPath(), enrollmentCode);
  for (const instance of cfg.instances) {
    removeEnrollmentTokenByCode(instancePaths(instance.id).enrollmentsPath, enrollmentCode);
  }
}

/** Aggregate paired devices across all instances (by fingerprint). */
export function listHubPairedDevices(cfg: HubConfig = loadOrCreateHubConfig()): HubPairedDevice[] {
  const byFp = new Map<string, HubPairedDevice>();

  for (const instance of cfg.instances) {
    const paths = instancePaths(instance.id);
    if (!paths.peersPath) continue;
    let peers;
    try {
      peers = loadOrCreatePeers({ path: paths.peersPath });
    } catch {
      continue;
    }
    for (const peer of peers.peers) {
      const existing = byFp.get(peer.fingerprint);
      if (existing === undefined) {
        byFp.set(peer.fingerprint, {
          fingerprint: peer.fingerprint,
          label: peer.label,
          instanceIds: [instance.id],
          addedAt: peer.addedAt ?? null,
        });
      } else {
        existing.instanceIds.push(instance.id);
        if (existing.addedAt === null && peer.addedAt !== undefined) {
          existing.addedAt = peer.addedAt;
        }
      }
    }
  }

  return [...byFp.values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
}

/** Revoke a paired device from every managed agent. */
export function removeHubPairedDevice(fingerprint: string, cfg: HubConfig = loadOrCreateHubConfig()): boolean {
  let removedAny = false;
  for (const instance of cfg.instances) {
    const paths = instancePaths(instance.id);
    if (removePeerByFingerprint(paths.peersPath, fingerprint)) {
      removedAny = true;
    }
  }
  return removedAny;
}

/** List outstanding hub-wide enrollment tokens. */
export function listHubEnrollments(): Array<EnrollmentToken & { display: string }> {
  const store = loadOrCreateEnrollments({ path: hubEnrollmentsPath() });
  return store.tokens.map((t) => ({ ...t, display: formatCodeForDisplay(t.code) }));
}

/** Revoke a hub enrollment token from hub + all instances. */
export function revokeHubEnrollment(code: string, cfg: HubConfig = loadOrCreateHubConfig()): boolean {
  let removed = removeEnrollmentTokenByCode(hubEnrollmentsPath(), code);
  for (const instance of cfg.instances) {
    if (removeEnrollmentTokenByCode(instancePaths(instance.id).enrollmentsPath, code)) {
      removed = true;
    }
  }
  return removed;
}

/** Ensure hub enrollments file exists. */
export function ensureHubPairingDir(): void {
  loadOrCreateEnrollments({ path: hubEnrollmentsPath() });
}
