/**
 * ACP v2 wire-envelope codec.
 *
 * Every WebSocket text frame between the Shepaw app and the ACP agent is a JSON
 * object of the shape:
 *
 *     {"v": 2, "t": "hs" | "data" | "err", "p": "<base64url>"}
 *
 * - `v` — protocol version, must be `2`
 * - `t` — frame type:
 *     * `"hs"`    Noise handshake message; `p` is the raw Noise message bytes
 *     * `"data"`  post-handshake; `p` is AEAD-encrypted JSON-RPC (or binary chunk)
 *     * `"err"`   plaintext error sent just before ws.close() — may be sent at any
 *                 time, including before handshake completes
 * - `p` — base64url payload, no padding
 *
 * Size limits defined here; enforcement is the caller's responsibility (caller
 * typically closes the WebSocket with a specific 44xx code on violation).
 */

// ── constants ──────────────────────────────────────────────────────

/** The only supported protocol version. */
export const PROTOCOL_VERSION = 2 as const;

/** Maximum payload bytes on the app→agent direction. */
export const MAX_FRAME_APP_TO_AGENT = 256 * 1024;

/** Maximum payload bytes on the agent→app direction. */
export const MAX_FRAME_AGENT_TO_APP = 4 * 1024 * 1024;

/** Hard cap on cumulative bytes received before the handshake completes. */
export const MAX_PREHANDSHAKE_BYTES = 16 * 1024;

/** WebSocket close codes used by the v2 protocol layer. */
export const WS_CLOSE = {
  UNSUPPORTED_VERSION: 4400,
  UNSUPPORTED_TYPE: 4401,
  FRAME_TOO_LARGE: 4402,
  FINGERPRINT_MISMATCH: 4403,
  AGENTID_MISMATCH: 4404,
  /** v2.1: Noise handshake succeeded but peer static pubkey is not on the allowlist. */
  PEER_NOT_AUTHORIZED: 4405,
  UNEXPECTED_HS_AFTER_READY: 4407,
  UNEXPECTED_DATA_BEFORE_READY: 4406,
  HANDSHAKE_TIMEOUT: 4408,
  HANDSHAKE_FAILED: 4409,
  MALFORMED_FRAME: 4410,
  /** v2.1: agent removed the peer from the allowlist mid-session (or peer self-unregistered). */
  UNREGISTERED: 4411,
} as const;

// ── types ──────────────────────────────────────────────────────────

export type FrameType = 'hs' | 'data' | 'err';

export interface Frame {
  readonly t: FrameType;
  /** Raw payload bytes. The on-wire form is base64url-encoded. */
  readonly payload: Uint8Array;
}

/** The error surface for `decodeFrame`. Use `.code` to pick the right close code. */
export class EnvelopeError extends Error {
  readonly code: keyof typeof WS_CLOSE;
  readonly closeCode: number;
  constructor(code: keyof typeof WS_CLOSE, message: string) {
    super(message);
    this.name = 'EnvelopeError';
    this.code = code;
    this.closeCode = WS_CLOSE[code];
  }
}

// ── encode ─────────────────────────────────────────────────────────

/**
 * Encode a frame to the on-wire JSON string form.
 *
 * Does NOT enforce size limits — callers should check `payload.length` against
 * the applicable MAX_FRAME_* constant BEFORE calling encode, so that if the
 * limit is exceeded the caller can choose whether to close the WS or split
 * the message.
 */
export function encodeFrame(frame: Frame): string {
  const obj = {
    v: PROTOCOL_VERSION,
    t: frame.t,
    p: toBase64Url(frame.payload),
  };
  return JSON.stringify(obj);
}

// ── decode ─────────────────────────────────────────────────────────

/**
 * Decode an on-wire JSON string into a Frame.
 *
 * Throws `EnvelopeError` (not plain `Error`) so the WS glue can pick a specific
 * WebSocket close code (`err.closeCode`) without re-guessing the category.
 *
 * `maxPayload` defaults to the agent→app limit (4 MiB) because that is the
 * larger of the two and therefore the safe upper bound for a generic decoder.
 * Callers with tighter limits should pass their own.
 */
export function decodeFrame(raw: string, maxPayload: number = MAX_FRAME_AGENT_TO_APP): Frame {
  // JSON parse with a specific error.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new EnvelopeError('MALFORMED_FRAME', 'Frame is not valid JSON');
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new EnvelopeError('MALFORMED_FRAME', 'Frame must be a JSON object');
  }
  const obj = parsed as Record<string, unknown>;

  if (obj.v !== PROTOCOL_VERSION) {
    throw new EnvelopeError(
      'UNSUPPORTED_VERSION',
      `Unsupported protocol version: expected ${PROTOCOL_VERSION}, got ${JSON.stringify(obj.v)}`,
    );
  }

  if (obj.t !== 'hs' && obj.t !== 'data' && obj.t !== 'err') {
    throw new EnvelopeError(
      'UNSUPPORTED_TYPE',
      `Unsupported frame type: ${JSON.stringify(obj.t)}`,
    );
  }

  if (typeof obj.p !== 'string') {
    throw new EnvelopeError('MALFORMED_FRAME', "Frame field 'p' must be a base64url string");
  }

  let payload: Uint8Array;
  try {
    payload = fromBase64Url(obj.p);
  } catch (err) {
    throw new EnvelopeError(
      'MALFORMED_FRAME',
      `Frame payload is not valid base64url: ${(err as Error).message}`,
    );
  }

  if (payload.length > maxPayload) {
    throw new EnvelopeError(
      'FRAME_TOO_LARGE',
      `Frame payload ${payload.length} bytes exceeds limit ${maxPayload}`,
    );
  }

  return { t: obj.t, payload };
}

// ── base64url ──────────────────────────────────────────────────────

/** Encode raw bytes as unpadded base64url. */
export function toBase64Url(bytes: Uint8Array): string {
  // Node Buffer supports 'base64url' directly (stripping padding) since 16+.
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64url');
}

/**
 * Decode unpadded base64url to raw bytes. Accepts padded input too for
 * generosity (some encoders emit `=` padding).
 */
export function fromBase64Url(s: string): Uint8Array {
  // Reject anything that contains standard-base64 chars (+ /) to make sure we're
  // actually getting base64url — lenient decoding here would let an encoder's bug
  // go undetected for weeks.
  if (/[+/]/.test(s)) {
    throw new Error("expected base64url, got standard base64 characters ('+' or '/')");
  }
  // `Buffer.from(..., 'base64url')` accepts both padded and unpadded inputs.
  const buf = Buffer.from(s, 'base64url');
  // Round-trip to detect non-base64 garbage — Node's decoder is lenient.
  const reencoded = buf.toString('base64url');
  // Strip any trailing '=' from input to compare.
  const normalized = s.replace(/=+$/, '');
  if (normalized !== reencoded) {
    throw new Error('input contains non-base64url characters');
  }
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
