/**
 * Pairing code + QR construction for the peer service.
 *
 * Mirrors the Shepaw app's `lib/peer/services/peer_pairing_service.dart`:
 *   - 8-char code, charset `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no 0/O/1/I/L).
 *   - 5-minute TTL, single-use, constant-time compare.
 *   - QR: `shepaw://peer?local=<ws>&code=<8char>#fp=<16hex>&pk=<base64url>`.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import type { HubConfig } from '../config.js';
import { detectLanIPv4 } from '../network.js';
import { peerPairingPath } from '../paths.js';

const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_TTL_MS = 5 * 60 * 1000;

export interface PairingFileEntry {
  readonly code: string;
  readonly expiresAt: number;
  readonly qrPayload: string;
  readonly localEndpoint: string;
  readonly createdAt: number;
}

/** Path to the active pairing-code file (CLI writes, daemon reads). */
export function getPairingFilePath(): string {
  return peerPairingPath();
}

/** Write a pairing-code entry to disk (the running daemon reads it on handshake). */
export function writePairingFile(entry: PairingFileEntry): void {
  const path = peerPairingPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry, null, 2), { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Read the active pairing code if present and not expired; else undefined. */
export function readActivePairingFile(): PairingFileEntry | undefined {
  const path = peerPairingPath();
  if (!existsSync(path)) return undefined;
  try {
    const entry = JSON.parse(readFileSync(path, 'utf-8')) as PairingFileEntry;
    if (Date.now() >= entry.expiresAt) return undefined;
    return entry;
  } catch {
    return undefined;
  }
}

/** Clear the pairing file (called by the daemon after a successful pairing). */
export function clearPairingFile(): void {
  const path = peerPairingPath();
  try { unlinkSync(path); } catch { /* ignore */ }
}

/** Generate an 8-char pairing code using CSPRNG (~40 bit). */
export function generatePairingCode(): string {
  const out: string[] = [];
  const buf = randomBytes(PAIRING_CODE_LENGTH);
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    out.push(PAIRING_CODE_ALPHABET[buf[i]! % PAIRING_CODE_ALPHABET.length]!);
  }
  return out.join('');
}

/** Constant-time string equality (avoids timing oracles on the pairing code). */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** base64url, unpadded — matches the app's `pk` fragment encoding. */
function base64urlUnpadded(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

export interface PeerQrOptions {
  /** Local LAN WS endpoint, e.g. ws://192.168.1.5:18792/peer/ws. */
  localEndpoint: string;
  /** Optional channel-relay endpoint (WAN). Omitted for LAN-only Phase 1. */
  channelEndpoint?: string;
  /** 8-char pairing code. */
  code: string;
  /** Responder fingerprint (16 hex). */
  fingerprint: string;
  /** Responder X25519 static public key (32 bytes). */
  publicKey: Uint8Array;
}

/**
 * Build the `shepaw://peer?...#fp=...&pk=...` QR payload.
 * `local` and `channel` are URL-encoded; `fp`/`pk` live in the fragment raw.
 */
export function buildPeerQrPayload(opts: PeerQrOptions): string {
  const params = new URLSearchParams();
  params.set('local', opts.localEndpoint);
  if (opts.channelEndpoint !== undefined && opts.channelEndpoint.length > 0) {
    params.set('channel', opts.channelEndpoint);
  }
  params.set('code', opts.code);
  const pk = base64urlUnpadded(opts.publicKey);
  return `shepaw://peer?${params.toString()}#fp=${opts.fingerprint}&pk=${pk}`;
}

/**
 * Resolve the LAN `local` endpoint the phone should connect to. The peer
 * service binds 0.0.0.0; the QR advertises the LAN IPv4 so the phone (on the
 * same network) can reach it.
 */
export function resolveLocalEndpoint(port: number, host: string): string {
  const ip = host === '0.0.0.0' || host === '127.0.0.1'
    ? detectLanIPv4() ?? '127.0.0.1'
    : host;
  return `ws://${ip}:${port}/peer/ws`;
}

/**
 * WAN peer WS URL via the shared gateway channel. Omitted when no tunnel is
 * configured. The tunnel router forwards `/peer/ws` to the local peer service.
 */
export function resolvePeerChannelEndpoint(cfg: HubConfig): string | undefined {
  const t = cfg.gateway?.tunnel;
  if (t === undefined) return undefined;
  const wsBase = t.serverUrl
    .replace(/\/+$/, '')
    .replace(/^https:\/\//, 'wss://')
    .replace(/^http:\/\//, 'ws://');
  return `${wsBase}/proxy/${t.channelId}/peer/ws`;
}
