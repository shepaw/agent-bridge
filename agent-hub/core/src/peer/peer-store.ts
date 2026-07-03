/**
 * Persistent paired-device store for the peer service.
 *
 * One record per phone that has paired with this hub. The pubkey is used to
 * match incoming reconnects (the reconnect handshake reveals the initiator's
 * static pubkey; we look it up here). Phase 1 persists records but reconnect
 * matching lands in Phase 2 — the store is write-now so paired devices survive
 * restarts.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { peerDevicesPath } from '../paths.js';

export interface PairedPeer {
  /** Hub-assigned peer id (UUID). */
  readonly id: string;
  /** Phone's display name (from PairingRequest.device_name). */
  readonly deviceName: string;
  /** Phone's stable device id (from PairingRequest.device_id). */
  readonly deviceId: string;
  /** Phone's X25519 static public key, base64. */
  readonly publicKey: string;
  /** Phone's fingerprint (16 hex). */
  readonly fingerprint: string;
  /** Phone's advertised endpoints (for reconnect). */
  readonly localEndpoint?: string;
  readonly channelEndpoint?: string;
  readonly pairedAt: string;
}

interface StoreShape {
  readonly version: 1;
  readonly peers: PairedPeer[];
}

export function loadPairedPeers(): PairedPeer[] {
  const path = peerDevicesPath();
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as StoreShape;
    if (!Array.isArray(parsed.peers)) return [];
    return parsed.peers;
  } catch {
    return [];
  }
}

function persistPeers(peers: PairedPeer[]): void {
  const path = peerDevicesPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  const data: StoreShape = { version: 1, peers };
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Add or replace a paired peer (keyed by fingerprint). */
export function upsertPairedPeer(peer: PairedPeer): PairedPeer[] {
  const existing = loadPairedPeers().filter((p) => p.fingerprint !== peer.fingerprint);
  const next = [peer, ...existing];
  persistPeers(next);
  return next;
}

/** Remove a paired peer by fingerprint. Returns the resulting list. */
export function removePairedPeer(fingerprint: string): PairedPeer[] {
  const next = loadPairedPeers().filter((p) => p.fingerprint !== fingerprint);
  persistPeers(next);
  return next;
}
