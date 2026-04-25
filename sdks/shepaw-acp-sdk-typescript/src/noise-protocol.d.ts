/**
 * TypeScript declarations for the `noise-protocol` npm package.
 *
 * The library is pure JavaScript, ships no `.d.ts`, and its README documents only
 * a handful of the functions we actually use. The shapes below reflect the
 * actual runtime behavior as observed against `noise-protocol@3.0.2`:
 *
 *   - `HandshakeState` — opaque object carried across `readMessage`/`writeMessage`.
 *   - `Split` — `{ tx: Uint8Array(40), rx: Uint8Array(40) }` (40 = KEYLEN 32 + NONCELEN 8).
 *     `tx` / `rx` are transport CipherState objects; pass them into the separately-
 *     imported `cipher-state` module's `encryptWithAd` / `decryptWithAd`.
 *   - `writeMessage.bytes` / `readMessage.bytes` — sidechannel output length carried
 *     on the function object after each call (library convention).
 *
 * Suite: the only supported suite is `Noise_<PATTERN>_25519_ChaChaPoly_BLAKE2b`.
 */

declare module 'noise-protocol' {
  export interface KeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  }

  /** Opaque handshake state. Carry across writeMessage/readMessage calls. */
  export type HandshakeState = object;

  /** Post-handshake transport keys. Each is a 40-byte CipherState blob. */
  export interface Split {
    tx: Uint8Array;
    rx: Uint8Array;
  }

  export function keygen(): KeyPair;

  /**
   * Initialize a handshake state. Patterns supported include 'IK', 'XX', 'KK', etc.
   * @param initiator true for the initiator, false for the responder
   * @param prologue arbitrary bytes mixed into the handshake hash before message 1
   * @param staticKeys required for patterns that need a local static (IK both sides: yes)
   * @param ephemeralKeys optional; normally omitted so the library generates a fresh e
   * @param remoteStaticKey required for the initiator of IK (pinned peer static pubkey)
   */
  export function initialize(
    pattern: string,
    initiator: boolean,
    prologue: Uint8Array,
    staticKeys?: KeyPair | null,
    ephemeralKeys?: KeyPair | null,
    remoteStaticKey?: Uint8Array | null,
    remoteEphemeralKey?: Uint8Array | null,
  ): HandshakeState;

  /**
   * Write a handshake message. Writes to `out` starting at offset 0 and reports
   * the actual number of bytes written on `writeMessage.bytes`.
   *
   * Returns `undefined` until the final pattern token is processed, at which point
   * it returns a `Split` with the two transport CipherStates. For IK, the second
   * call (responder writing message 2) returns the Split.
   */
  export function writeMessage(
    state: HandshakeState,
    payload: Uint8Array,
    out: Uint8Array,
  ): Split | undefined;
  export namespace writeMessage {
    /** Number of bytes written by the most recent call. */
    let bytes: number;
  }

  export function readMessage(
    state: HandshakeState,
    message: Uint8Array,
    out: Uint8Array,
  ): Split | undefined;
  export namespace readMessage {
    /** Number of plaintext-payload bytes written by the most recent call. */
    let bytes: number;
  }

  export function destroy(state: HandshakeState): void;

  export const PKLEN: number;
  export const SKLEN: number;
}

declare module 'noise-protocol/cipher-state.js' {
  export interface CipherStateModule {
    /** Length of a CipherState blob in bytes (KEYLEN + NONCELEN = 32 + 8 = 40). */
    STATELEN: number;
    NONCELEN: number;
    MACLEN: number;

    initializeKey(state: Uint8Array, key: Uint8Array | null): void;
    hasKey(state: Uint8Array): boolean;
    setNonce(state: Uint8Array, nonce: Uint8Array): void;

    /**
     * AEAD-encrypts `plaintext` under the CipherState `state`, writing to `out`.
     * The number of bytes written is reported on `encryptWithAd.bytesWritten`.
     * Nonce is auto-incremented.
     */
    encryptWithAd(
      state: Uint8Array,
      out: Uint8Array,
      ad: Uint8Array,
      plaintext: Uint8Array,
    ): void;

    /**
     * AEAD-decrypts `ciphertext` under the CipherState `state`, writing to `out`.
     * The number of bytes written is reported on `decryptWithAd.bytesWritten`.
     * Throws on AEAD tag mismatch.
     */
    decryptWithAd(
      state: Uint8Array,
      out: Uint8Array,
      ad: Uint8Array,
      ciphertext: Uint8Array,
    ): void;

    rekey(state: Uint8Array): void;
  }
  export namespace encryptWithAd {
    let bytesRead: number;
    let bytesWritten: number;
  }
  export namespace decryptWithAd {
    let bytesRead: number;
    let bytesWritten: number;
  }

  const factory: (deps: { cipher: unknown }) => CipherStateModule;
  export default factory;
}

declare module 'noise-protocol/cipher.js' {
  /** Returns the ChaCha20-Poly1305 cipher primitive used internally. */
  const factory: () => unknown;
  export default factory;
}
