/**
 * Noise IK session wrapper — the TypeScript (responder) side.
 *
 * Implements `Noise_IK_25519_ChaChaPoly_BLAKE2b`. The Shepaw app is the
 * initiator; the agent is always the responder. (If that ever changes,
 * `NoiseSession.initiator(...)` would be added symmetrically.)
 *
 * Wraps the untyped `noise-protocol` npm package. The library gives us a
 * state machine but we pick the framing: each `HandshakeState` is used for
 * exactly two messages (read msg 1, write msg 2), then it's destroyed and
 * we keep only the two post-split `CipherState` byte blobs.
 *
 * Suite justification: `noise-protocol` only supports `ChaChaPoly_BLAKE2b`.
 * BLAKE2b is a valid Noise hash choice and matches WireGuard's selection.
 * Our on-wire fingerprint stays SHA-256 (see identity.ts) since those are
 * independent — the fingerprint is a pairing UX concern, not a Noise
 * internal.
 *
 * Thread-safety: none. Each connection gets its own `NoiseSession`. The two
 * CipherState blobs have internal nonce counters mutated on every call, so
 * do not concurrent-encrypt or concurrent-decrypt from multiple callers
 * against the same direction.
 */

import noise from 'noise-protocol';
import cipherStateFactory from 'noise-protocol/cipher-state.js';
import cipherFactory from 'noise-protocol/cipher.js';

import type { AgentIdentity } from './identity.js';

// ── Module-level singletons for the cipher-state API ───────────────
//
// `noise-protocol` exposes cipher-state as a factory that needs the internal
// cipher primitive. Building this once saves ~microseconds per message but
// mostly it's here so the module graph is predictable.

const _cipher = cipherFactory();
const _cs = cipherStateFactory({ cipher: _cipher });

// ── Public constants ───────────────────────────────────────────────

/** Length in bytes of a CipherState blob (32 key + 8 nonce). */
export const CIPHER_STATE_LEN = _cs.STATELEN;
/** AEAD tag length — 16 bytes for ChaCha20-Poly1305. */
export const MAC_LEN = _cs.MACLEN;

/** Prologue string; bound into every handshake to prevent cross-version confusion. */
export const NOISE_PROLOGUE = Buffer.from('shepaw-acp/2.1', 'utf-8');

// ── Types ──────────────────────────────────────────────────────────

/**
 * Information collected during the IK handshake that the server may want to
 * act on (e.g. per-device authorization later).
 */
export interface HandshakeResult {
  /**
   * The initiator's static public key, learned from handshake message 1.
   * 32 bytes. Persist per-device in future versions; v2 just logs it.
   */
  peerStaticPublicKey: Uint8Array;
  /** Plaintext payload carried by message 1 (UTF-8 JSON agreed-upon by the app & agent). */
  msg1Payload: Uint8Array;
}

/** Thrown when the Noise handshake cannot be completed. */
export class NoiseHandshakeError extends Error {
  override readonly name = 'NoiseHandshakeError';
}

/** Thrown when an AEAD-protected transport frame fails to decrypt. */
export class NoiseTransportError extends Error {
  override readonly name = 'NoiseTransportError';
}

// ── NoiseSession (responder side) ──────────────────────────────────

/**
 * A single Noise IK session, from the responder's perspective.
 *
 * Lifecycle:
 *   1. `NoiseSession.responder(identity, prologue?)` — creates handshake state.
 *   2. `readHandshake1(rawBytes)` — consumes incoming msg 1 bytes, returns decrypted payload + peer static.
 *   3. `writeHandshake2(payload)` — produces msg 2 bytes, completes handshake, stores CipherStates.
 *   4. `encrypt(plaintext)` / `decrypt(ciphertext)` — post-handshake transport.
 *
 * An initiator-side factory `NoiseSession.initiator(...)` is also provided;
 * production code path only needs the responder (the Shepaw app is the
 * initiator), but the initiator path is used by tests and potentially by
 * future agent-to-agent workflows.
 *
 * Calling these out of order throws `NoiseHandshakeError`.
 */
export class NoiseSession {
  private readonly prologue: Buffer;

  /** `noise-protocol` opaque HandshakeState. Null after split. */
  private hsState: object | null = null;

  /** Set after `readHandshake1` (responder) or after `writeHandshake1` (initiator). */
  private _peerStaticPublicKey: Uint8Array | null = null;

  /** CipherState for sending. 40 bytes. */
  private sendState: Uint8Array | null = null;

  /** CipherState for receiving. 40 bytes. */
  private recvState: Uint8Array | null = null;

  /** Monotone guard against out-of-order API calls. */
  private phase:
    | 'AWAIT_HS1'          // responder: waiting for msg 1
    | 'AWAIT_HS2_WRITE'    // responder: ready to write msg 2
    | 'AWAIT_HS1_WRITE'    // initiator: ready to write msg 1
    | 'AWAIT_HS2'          // initiator: waiting for msg 2
    | 'READY'
    | 'CLOSED' = 'AWAIT_HS1';

  private readonly role: 'initiator' | 'responder';

  private constructor(
    role: 'initiator' | 'responder',
    hsState: object,
    prologue: Buffer,
    peerStaticPublicKey: Uint8Array | null,
  ) {
    this.role = role;
    this.prologue = prologue;
    this.hsState = hsState;
    this._peerStaticPublicKey = peerStaticPublicKey;
    this.phase = role === 'responder' ? 'AWAIT_HS1' : 'AWAIT_HS1_WRITE';
  }

  /** Create a responder-side NoiseSession using the agent's long-term identity. */
  static responder(identity: AgentIdentity, prologue: Buffer = NOISE_PROLOGUE): NoiseSession {
    const staticKeyPair = {
      publicKey: identity.staticPublicKey,
      secretKey: identity.staticPrivateKey,
    };
    const hs = noise.initialize('IK', false, prologue, staticKeyPair);
    return new NoiseSession('responder', hs, prologue, null);
  }

  /**
   * Create an initiator-side NoiseSession. The caller must provide:
   *   - the initiator's own long-term keypair (32-byte pub + priv)
   *   - the responder's pinned static public key (32 bytes), obtained from
   *     the URL `#fp=` + first-contact handshake or cached from a prior session
   *
   * Primarily used for tests and for cross-language vector verification.
   *
   * Note: `noise-protocol@3` does not support injecting a specific ephemeral
   * keypair for IK; its initialize() accepts `e` but the pattern's `TOK_E`
   * handler asserts that `epk == null` and then generates a fresh one. So we
   * cannot produce byte-reproducible handshake messages on the TS side for
   * cross-language fixtures. The Dart side DOES support injection (see its
   * `HandshakeState.ephemeralForTesting`), so a future Dart→TS interop test
   * is possible; v2 relies on "msg 1 decrypts correctly on the responder" +
   * "both sides pass RFC primitive vectors" to certify interop.
   */
  static initiator(
    opts: {
      staticPublicKey: Uint8Array;
      staticPrivateKey: Uint8Array;
      remoteStaticPublicKey: Uint8Array;
      prologue?: Buffer;
    },
  ): NoiseSession {
    const prologue = opts.prologue ?? NOISE_PROLOGUE;
    const hs = noise.initialize(
      'IK',
      true,
      prologue,
      { publicKey: opts.staticPublicKey, secretKey: opts.staticPrivateKey },
      null,
      opts.remoteStaticPublicKey,
    );
    return new NoiseSession('initiator', hs, prologue, new Uint8Array(opts.remoteStaticPublicKey));
  }

  /** The initiator's static public key, available after `readHandshake1`. */
  get peerStaticPublicKey(): Uint8Array {
    if (this._peerStaticPublicKey === null) {
      throw new NoiseHandshakeError('peerStaticPublicKey not yet known (call readHandshake1 first)');
    }
    return this._peerStaticPublicKey;
  }

  /** True once both handshake messages have been processed and the session is ready for transport. */
  get ready(): boolean {
    return this.phase === 'READY';
  }

  /**
   * Read handshake message 1 from the initiator (app).
   *
   * On success, stores `peerStaticPublicKey` internally and advances to AWAIT_HS2_WRITE.
   * On failure, transitions to CLOSED and throws `NoiseHandshakeError`.
   *
   * NEVER leak the underlying library error back to the peer — that would turn
   * the AEAD into a decrypt oracle. Callers should close the WebSocket with a
   * generic close code (e.g. 4409 HANDSHAKE_FAILED) and not echo `err.message`.
   */
  readHandshake1(msg1: Uint8Array): HandshakeResult {
    if (this.phase !== 'AWAIT_HS1') {
      throw new NoiseHandshakeError(`readHandshake1 called in phase ${this.phase}`);
    }
    if (this.hsState === null) {
      throw new NoiseHandshakeError('handshake state unavailable');
    }

    // Enough headroom for a 4 KiB handshake payload, well above realistic use.
    const out = Buffer.alloc(msg1.length);
    try {
      const split = noise.readMessage(this.hsState, msg1, out);
      if (split !== undefined) {
        // IK responder shouldn't split after message 1 — that would mean the
        // library thinks the handshake finished after one message. Defensive check.
        this.phase = 'CLOSED';
        throw new NoiseHandshakeError('IK split returned after message 1 (library bug or wrong pattern)');
      }
    } catch (err) {
      this.phase = 'CLOSED';
      throw wrapHandshakeError(err, 'readHandshake1 failed');
    }

    const payloadLen = noise.readMessage.bytes;
    const msg1Payload = new Uint8Array(out.buffer, out.byteOffset, payloadLen);

    // Extract peer static pubkey from the handshake state.
    // The library doesn't expose this directly, but since msg 1 of IK is
    // `-> e, es, s, ss`, after reading msg 1 the `rs` slot holds it.
    const peerStatic = extractRemoteStatic(this.hsState);
    if (peerStatic === null) {
      this.phase = 'CLOSED';
      throw new NoiseHandshakeError('peer static public key not found in handshake state');
    }

    this._peerStaticPublicKey = peerStatic;
    this.phase = 'AWAIT_HS2_WRITE';

    return {
      peerStaticPublicKey: peerStatic,
      // Copy out so the caller owns the bytes; otherwise subsequent writes
      // could clobber them when we reuse buffers.
      msg1Payload: new Uint8Array(msg1Payload),
    };
  }

  /**
   * Write handshake message 2 (agent → app). Requires `readHandshake1` first.
   *
   * After this returns, the handshake is complete and transport encryption is
   * usable via `encrypt`/`decrypt`. The internal HandshakeState is destroyed
   * so sensitive intermediate keys are released to GC.
   */
  writeHandshake2(payload: Uint8Array): Uint8Array {
    if (this.phase !== 'AWAIT_HS2_WRITE') {
      throw new NoiseHandshakeError(`writeHandshake2 called in phase ${this.phase}`);
    }
    if (this.hsState === null) {
      throw new NoiseHandshakeError('handshake state unavailable');
    }

    // Message 2 = ephemeral (32) + empty payload encrypted with MAC (16) + payload
    // + MAC for optional extra payload. Sizing 64 + payload.length + 32 is safe.
    const out = Buffer.alloc(payload.length + 96);

    let split: { tx: Uint8Array; rx: Uint8Array } | undefined;
    try {
      split = noise.writeMessage(this.hsState, payload, out);
    } catch (err) {
      this.phase = 'CLOSED';
      throw wrapHandshakeError(err, 'writeHandshake2 failed');
    }

    if (split === undefined) {
      this.phase = 'CLOSED';
      throw new NoiseHandshakeError('IK writeMessage did not return a split after message 2');
    }

    // On the responder, split.tx encrypts toward initiator (our send), split.rx
    // decrypts from initiator (our receive).
    this.sendState = split.tx;
    this.recvState = split.rx;

    try {
      noise.destroy(this.hsState);
    } catch {
      /* best effort */
    }
    this.hsState = null;
    this.phase = 'READY';

    const written = noise.writeMessage.bytes;
    return new Uint8Array(out.buffer, out.byteOffset, written).slice();
  }

  // ── Initiator side ────────────────────────────────────────────

  /**
   * Initiator-only: produce handshake message 1 to send to the responder.
   *
   * Advances phase to `AWAIT_HS2`. After the network delivers msg 2, call
   * `readHandshake2(bytes)` to complete the handshake.
   */
  writeHandshake1(payload: Uint8Array): Uint8Array {
    if (this.role !== 'initiator') {
      throw new NoiseHandshakeError('writeHandshake1 called on non-initiator session');
    }
    if (this.phase !== 'AWAIT_HS1_WRITE') {
      throw new NoiseHandshakeError(`writeHandshake1 called in phase ${this.phase}`);
    }
    if (this.hsState === null) {
      throw new NoiseHandshakeError('handshake state unavailable');
    }
    const out = Buffer.alloc(payload.length + 128);
    try {
      const split = noise.writeMessage(this.hsState, payload, out);
      if (split !== undefined) {
        this.phase = 'CLOSED';
        throw new NoiseHandshakeError('IK split returned after initiator msg 1 (library bug)');
      }
    } catch (err) {
      this.phase = 'CLOSED';
      throw wrapHandshakeError(err, 'writeHandshake1 failed');
    }
    this.phase = 'AWAIT_HS2';
    const written = noise.writeMessage.bytes;
    return new Uint8Array(out.buffer, out.byteOffset, written).slice();
  }

  /**
   * Initiator-only: consume handshake message 2 from the responder. Completes
   * the handshake and stores CipherStates.
   *
   * Returns the decrypted msg 2 payload (UTF-8 JSON agreed-upon between app & agent).
   */
  readHandshake2(msg2: Uint8Array): Uint8Array {
    if (this.role !== 'initiator') {
      throw new NoiseHandshakeError('readHandshake2 called on non-initiator session');
    }
    if (this.phase !== 'AWAIT_HS2') {
      throw new NoiseHandshakeError(`readHandshake2 called in phase ${this.phase}`);
    }
    if (this.hsState === null) {
      throw new NoiseHandshakeError('handshake state unavailable');
    }
    const out = Buffer.alloc(msg2.length);
    let split: { tx: Uint8Array; rx: Uint8Array } | undefined;
    try {
      split = noise.readMessage(this.hsState, msg2, out);
    } catch (err) {
      this.phase = 'CLOSED';
      throw wrapHandshakeError(err, 'readHandshake2 failed');
    }
    if (split === undefined) {
      this.phase = 'CLOSED';
      throw new NoiseHandshakeError('IK readMessage did not return a split after msg 2');
    }
    // Initiator: split.tx encrypts toward responder; split.rx decrypts from responder.
    this.sendState = split.tx;
    this.recvState = split.rx;

    try {
      noise.destroy(this.hsState);
    } catch {
      /* best effort */
    }
    this.hsState = null;
    this.phase = 'READY';

    const written = noise.readMessage.bytes;
    return new Uint8Array(out.buffer, out.byteOffset, written).slice();
  }

  /** Encrypt a single transport message. Nonce is auto-incremented. */
  encrypt(plaintext: Uint8Array, ad: Uint8Array = EMPTY): Uint8Array {
    if (this.phase !== 'READY' || this.sendState === null) {
      throw new NoiseTransportError('session not ready for encryption');
    }
    const out = Buffer.alloc(plaintext.length + MAC_LEN);
    try {
      _cs.encryptWithAd(this.sendState, out, ad, plaintext);
    } catch (err) {
      // Nonce overflow or similar — any error here is fatal for the session.
      this.phase = 'CLOSED';
      throw new NoiseTransportError(`encryptWithAd failed: ${(err as Error).message}`);
    }
    const written = _encryptBytesWritten();
    return new Uint8Array(out.buffer, out.byteOffset, written).slice();
  }

  /** Decrypt a single transport message. Throws `NoiseTransportError` on tag failure. */
  decrypt(ciphertext: Uint8Array, ad: Uint8Array = EMPTY): Uint8Array {
    if (this.phase !== 'READY' || this.recvState === null) {
      throw new NoiseTransportError('session not ready for decryption');
    }
    // Can't pre-size exactly; plaintext = ct - 16. But allocate max(ct.length, 1).
    const out = Buffer.alloc(Math.max(ciphertext.length, 1));
    try {
      _cs.decryptWithAd(this.recvState, out, ad, ciphertext);
    } catch (err) {
      // Any decrypt failure here is fatal — the peer either tampered, the
      // nonce desynced, or the peer's session got corrupted. Close the
      // connection; do NOT surface the underlying reason (oracle risk).
      this.phase = 'CLOSED';
      throw new NoiseTransportError(`decryptWithAd failed: ${(err as Error).message}`);
    }
    const written = _decryptBytesWritten();
    return new Uint8Array(out.buffer, out.byteOffset, written).slice();
  }

  /** Release any live handshake state and zero the CipherStates. */
  close(): void {
    if (this.hsState !== null) {
      try {
        noise.destroy(this.hsState);
      } catch {
        /* ignore */
      }
      this.hsState = null;
    }
    if (this.sendState !== null) this.sendState.fill(0);
    if (this.recvState !== null) this.recvState.fill(0);
    this.sendState = null;
    this.recvState = null;
    this.phase = 'CLOSED';
  }
}

// ── Helpers ────────────────────────────────────────────────────────

const EMPTY = new Uint8Array(0);

/**
 * Read the per-call output length set by the last `encryptWithAd` invocation.
 * The library hangs these as properties on the function object; the TS
 * declaration (`noise-protocol.d.ts`) declares them via a namespace but they're
 * not on the `CipherStateModule` interface itself, so we reach through `unknown`.
 */
function _encryptBytesWritten(): number {
  return (_cs.encryptWithAd as unknown as { bytesWritten: number }).bytesWritten;
}

function _decryptBytesWritten(): number {
  return (_cs.decryptWithAd as unknown as { bytesWritten: number }).bytesWritten;
}

/**
 * Reach into the untyped HandshakeState object to recover the remote static
 * public key after message 1 has been read. The library stores it under the
 * `rs` property.
 *
 * This is admittedly fragile — if noise-protocol renames the internal field in
 * a future version, this breaks. The right response is to pin the library
 * version in package.json (done) and let a test catch the regression.
 */
function extractRemoteStatic(hs: object): Uint8Array | null {
  const candidate = (hs as { rs?: unknown }).rs;
  if (candidate instanceof Uint8Array && candidate.length === 32) {
    // Copy so the caller can keep it after we destroy the handshake state.
    return new Uint8Array(candidate);
  }
  return null;
}

function wrapHandshakeError(err: unknown, prefix: string): NoiseHandshakeError {
  const msg = err instanceof Error ? err.message : String(err);
  return new NoiseHandshakeError(`${prefix}: ${msg}`);
}
