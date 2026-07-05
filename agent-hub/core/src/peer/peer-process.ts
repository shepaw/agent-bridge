/**
 * Spawn/stop control for the device-level peer service, mirroring
 * `gateway-process.ts`. Also exposes `mintPairingQr` used by `peer pair`:
 * it ensures the daemon is running, generates a 6-char code, writes it to
 * `peer-pairing.json` (which the daemon reads on the next handshake), and
 * returns the `shepaw://peer?...` QR payload.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { isAlive, type StopResult } from '../spawn.js';
import { loadOrCreateHubConfig, DEFAULT_PEER_HOST, DEFAULT_PEER_PORT } from '../config.js';
import { loadOrCreatePeerIdentity } from './peer-identity.js';
import {
  buildPeerQrPayload,
  generatePairingCode,
  PAIRING_TTL_MS,
  resolveLocalEndpoint,
  resolvePeerChannelEndpoint,
  writePairingFile,
  type PairingFileEntry,
} from './peer-pairing.js';
import { peerLogFile, peerLogsDir, peerStatePath } from '../paths.js';

interface PeerState {
  pid: number;
  port: number;
  host: string;
  startedAt: string;
}

function readPeerState(): PeerState | undefined {
  try {
    return JSON.parse(readFileSync(peerStatePath(), 'utf-8')) as PeerState;
  } catch {
    return undefined;
  }
}

function writePeerState(state: PeerState): void {
  const path = peerStatePath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function isPeerServiceRunning(): boolean {
  const state = readPeerState();
  return state !== undefined && state.pid > 0 && isAlive(state.pid);
}

/** Start the peer service (detached). Idempotent. */
export async function startPeerService(
  cfg = loadOrCreateHubConfig(),
): Promise<{ pid: number; alreadyRunning: boolean; port: number; host: string }> {
  const prior = readPeerState();
  const host = cfg.peer?.host ?? DEFAULT_PEER_HOST;
  const port = cfg.peer?.port ?? DEFAULT_PEER_PORT;
  if (prior !== undefined && prior.pid > 0 && isAlive(prior.pid)) {
    return { pid: prior.pid, alreadyRunning: true, port: prior.port, host: prior.host };
  }

  const daemonPath = resolveDaemonPath();
  mkdirSync(peerLogsDir(), { recursive: true, mode: 0o700 });
  const logFd = openSync(peerLogFile(), 'a');

  try {
    const child = nodeSpawn(process.execPath, [daemonPath], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env },
    });
    child.unref();

    await sleep(300);
    if (!isAlive(child.pid!)) {
      throw new Error(
        `Peer service exited immediately. Check logs:\n  ${peerLogFile()}\n` +
          `Common causes: port ${port} already in use.`,
      );
    }

    writePeerState({ pid: child.pid!, port, host, startedAt: new Date().toISOString() });
    return { pid: child.pid!, alreadyRunning: false, port, host };
  } finally {
    try { closeSync(logFd); } catch { /* ignore */ }
  }
}

/** Stop the peer service. */
export async function stopPeerService(): Promise<StopResult> {
  const prior = readPeerState();
  if (prior === undefined || prior.pid === 0 || !isAlive(prior.pid)) {
    return 'not-running';
  }
  const pid = prior.pid;
  if (process.platform === 'win32') {
    try { process.kill(pid); } catch { /* already gone */ }
    return 'hard';
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return 'not-running';
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return 'graceful';
    await sleep(50);
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
  return 'hard';
}

/** Status payload for `peer status`. */
export function peerServiceStatus(): {
  running: boolean;
  pid: number | null;
  port: number;
  host: string;
  startedAt: string | null;
} {
  const state = readPeerState();
  const running = state !== undefined && state.pid > 0 && isAlive(state.pid);
  return {
    running,
    pid: running ? state!.pid : null,
    port: state?.port ?? DEFAULT_PEER_PORT,
    host: state?.host ?? DEFAULT_PEER_HOST,
    startedAt: state?.startedAt ?? null,
  };
}

export interface MintPairingResult {
  code: string;
  qrPayload: string;
  expiresAt: number;
  localEndpoint: string;
  /** WAN endpoint via shared channel; present when gateway tunnel is configured. */
  channelEndpoint?: string;
  fingerprint: string;
}

/**
 * Ensure the peer service is running, mint a 6-char code, write it to the
 * pairing file (daemon reads on handshake), and return the QR payload.
 */
export async function mintPairingQr(): Promise<MintPairingResult> {
  const cfg = loadOrCreateHubConfig();
  const { port, host } = await startPeerService(cfg);
  const identity = loadOrCreatePeerIdentity();
  const code = generatePairingCode();
  const localEndpoint = resolveLocalEndpoint(port, host);
  const channelEndpoint = resolvePeerChannelEndpoint(cfg);
  const qrPayload = buildPeerQrPayload({
    localEndpoint,
    channelEndpoint,
    code,
    fingerprint: identity.fingerprint,
    publicKey: identity.staticPublicKey,
  });
  const entry: PairingFileEntry = {
    code,
    expiresAt: Date.now() + PAIRING_TTL_MS,
    qrPayload,
    localEndpoint,
    createdAt: Date.now(),
  };
  writePairingFile(entry);
  return {
    code,
    qrPayload,
    expiresAt: entry.expiresAt,
    localEndpoint,
    channelEndpoint,
    fingerprint: identity.fingerprint,
  };
}

function resolveDaemonPath(): string {
  // peer-daemon.ts is a sibling entry under src/peer/, so the compiled chunk
  // sits at dist/peer/peer-daemon.js (this module is bundled into dist/index.js).
  const url = new URL('./peer/peer-daemon.js', import.meta.url);
  const jsPath = fileURLToPath(url);
  if (existsSync(jsPath)) return jsPath;
  const tsPath = fileURLToPath(new URL('./peer-daemon.ts', import.meta.url));
  if (existsSync(tsPath)) return tsPath;
  throw new Error(`Cannot locate peer-daemon entry (looked for ${jsPath}).`);
}
