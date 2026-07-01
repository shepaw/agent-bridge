/**
 * Hub-level device pairing — one QR scan authorizes a Shepaw app on every
 * managed agent (project) on this host.
 *
 * Flow (matches shepaw://pair in the Shepaw app):
 *   1. Operator mints a hub enrollment token (Dashboard or `shepaw-hub pair`).
 *   2. QR encodes bootstrap agent WS URL + one-time code.
 *   3. App scans, completes Noise handshake on the bootstrap gateway.
 *   4. Gateway fan-out hook adds the device pubkey to every project's peers file
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

import type { HubConfig, ProjectConfig } from './config.js';
import { loadOrCreateHubConfig } from './config.js';
import { hubEnrollmentsPath, projectPaths } from './paths.js';
import { ensureProjectDir, isAlive, readState } from './spawn.js';

export interface HubAgentCatalogEntry {
  projectId: string;
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
}

export interface HubPairingResult {
  code: string;
  display: string;
  label: string;
  expiresAt: string;
  createdAt: string;
  /** Bootstrap project used in the QR (first online, else first registered). */
  bootstrapProjectId: string;
  pairUrl: string;
  qrPayload: string;
  agents: HubAgentCatalogEntry[];
}

export interface HubPairedDevice {
  fingerprint: string;
  label: string;
  /** Project ids where this device is authorized. */
  projectIds: string[];
  addedAt: string | null;
}

export interface CreateHubPairingOptions {
  label?: string;
  ttlMs?: number;
  /** Override bootstrap project for the QR WS URL. */
  bootstrapProjectId?: string;
  /** Override public WS base for bootstrap (tunnel URL). */
  baseUrl?: string;
}

export interface FanOutPeerOptions {
  publicKeyB64: string;
  label: string;
  enrollmentCode: string;
}

function buildWsPairUrl(
  project: ProjectConfig,
  identity: { agentId: string; fingerprint: string; staticPublicKey: Uint8Array },
  baseUrl?: string,
): string {
  const pkEncoded = encodeURIComponent(
    Buffer.from(identity.staticPublicKey).toString('base64'),
  );
  const fragment = `fp=${identity.fingerprint}&pk=${pkEncoded}`;
  const resolvedBase = (baseUrl ?? project.baseUrl).replace(/\/$/, '');
  if (resolvedBase.length > 0) {
    return `${resolvedBase}/acp/ws?agentId=${identity.agentId}#${fragment}`;
  }
  return `ws://${project.host}:${project.port}/acp/ws?agentId=${identity.agentId}#${fragment}`;
}

function isProjectRunning(projectId: string): boolean {
  const state = readState(projectPaths(projectId).statePath);
  return state !== undefined && state.pid > 0 && isAlive(state.pid);
}

function pickBootstrapProject(cfg: HubConfig, preferredId?: string): ProjectConfig {
  if (cfg.projects.length === 0) {
    throw new Error('No projects registered. Add a project before pairing a device.');
  }
  if (preferredId !== undefined) {
    const found = cfg.projects.find((p) => p.id === preferredId);
    if (found === undefined) {
      throw new Error(`Unknown bootstrap project "${preferredId}".`);
    }
    return found;
  }
  const online = cfg.projects.find((p) => isProjectRunning(p.id));
  return online ?? cfg.projects[0]!;
}

/** List every managed agent with connection metadata for the Shepaw app. */
export function listHubAgentCatalog(cfg: HubConfig = loadOrCreateHubConfig()): HubAgentCatalogEntry[] {
  return cfg.projects.map((project) => {
    const paths = projectPaths(project.id);
    ensureProjectDir(project.id);
    const identity = loadOrCreateIdentity({ path: paths.identityPath });
    return {
      projectId: project.id,
      label: project.label,
      engine: project.engine,
      agentId: identity.agentId,
      fingerprint: identity.fingerprint,
      publicKey: Buffer.from(identity.staticPublicKey).toString('base64'),
      wsUrl: buildWsPairUrl(project, identity),
      host: project.host,
      port: project.port,
      running: isProjectRunning(project.id),
    };
  });
}

/** Newline-separated peer/enrollment paths for gateway fan-out env vars. */
export function hubFanoutEnvPaths(cfg: HubConfig = loadOrCreateHubConfig()): {
  peerPaths: string;
  enrollmentPaths: string;
} {
  const peerPaths = cfg.projects.map((p) => projectPaths(p.id).peersPath);
  const enrollmentPaths = [hubEnrollmentsPath(), ...cfg.projects.map((p) => projectPaths(p.id).enrollmentsPath)];
  return {
    peerPaths: peerPaths.join('\n'),
    enrollmentPaths: enrollmentPaths.join('\n'),
  };
}

/** Mint a hub-wide enrollment token replicated to every project. */
export function createHubPairing(opts: CreateHubPairingOptions = {}): HubPairingResult {
  const cfg = loadOrCreateHubConfig();
  const bootstrap = pickBootstrapProject(cfg, opts.bootstrapProjectId);
  const ttlMs = opts.ttlMs ?? 10 * 60 * 1000;
  const label = opts.label ?? 'Shepaw device';

  for (const project of cfg.projects) {
    ensureProjectDir(project.id);
  }

  const hubPath = hubEnrollmentsPath();
  const token = createEnrollmentToken(hubPath, { label, ttlMs });

  for (const project of cfg.projects) {
    syncEnrollmentToken(projectPaths(project.id).enrollmentsPath, token);
  }

  const bootstrapIdentity = loadOrCreateIdentity({ path: projectPaths(bootstrap.id).identityPath });
  const pairUrl = buildWsPairUrl(bootstrap, bootstrapIdentity, opts.baseUrl);
  const qrPayload = `shepaw://pair?url=${encodeURIComponent(pairUrl)}&code=${encodeURIComponent(token.code)}`;

  return {
    code: token.code,
    display: formatCodeForDisplay(token.code),
    label: token.label,
    expiresAt: token.expiresAt,
    createdAt: token.createdAt,
    bootstrapProjectId: bootstrap.id,
    pairUrl,
    qrPayload,
    agents: listHubAgentCatalog(cfg),
  };
}

/** After bootstrap handshake, authorize the device on every project. */
export function fanOutHubPeer(opts: FanOutPeerOptions, cfg: HubConfig = loadOrCreateHubConfig()): void {
  const { publicKeyB64, label, enrollmentCode } = opts;

  for (const project of cfg.projects) {
    const paths = projectPaths(project.id);
    try {
      addPeer(paths.peersPath, publicKeyB64, label);
    } catch (err) {
      throw new Error(
        `Failed to authorize peer on project "${project.id}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  removeEnrollmentTokenByCode(hubEnrollmentsPath(), enrollmentCode);
  for (const project of cfg.projects) {
    removeEnrollmentTokenByCode(projectPaths(project.id).enrollmentsPath, enrollmentCode);
  }
}

/** Aggregate paired devices across all projects (by fingerprint). */
export function listHubPairedDevices(cfg: HubConfig = loadOrCreateHubConfig()): HubPairedDevice[] {
  const byFp = new Map<string, HubPairedDevice>();

  for (const project of cfg.projects) {
    const paths = projectPaths(project.id);
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
          projectIds: [project.id],
          addedAt: peer.addedAt ?? null,
        });
      } else {
        existing.projectIds.push(project.id);
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
  for (const project of cfg.projects) {
    const paths = projectPaths(project.id);
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

/** Revoke a hub enrollment token from hub + all projects. */
export function revokeHubEnrollment(code: string, cfg: HubConfig = loadOrCreateHubConfig()): boolean {
  let removed = removeEnrollmentTokenByCode(hubEnrollmentsPath(), code);
  for (const project of cfg.projects) {
    if (removeEnrollmentTokenByCode(projectPaths(project.id).enrollmentsPath, code)) {
      removed = true;
    }
  }
  return removed;
}

/** Ensure hub enrollments file exists. */
export function ensureHubPairingDir(): void {
  loadOrCreateEnrollments({ path: hubEnrollmentsPath() });
}
