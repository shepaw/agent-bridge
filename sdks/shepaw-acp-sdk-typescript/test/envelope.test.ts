import { describe, expect, it } from 'vitest';

import {
  decodeFrame,
  encodeFrame,
  EnvelopeError,
  fromBase64Url,
  MAX_FRAME_APP_TO_AGENT,
  PROTOCOL_VERSION,
  toBase64Url,
  WS_CLOSE,
} from '../src/envelope.js';

describe('envelope encode / decode roundtrip', () => {
  it('roundtrips a handshake frame', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const encoded = encodeFrame({ t: 'hs', payload });
    const decoded = decodeFrame(encoded);
    expect(decoded.t).toBe('hs');
    expect(Array.from(decoded.payload)).toEqual([1, 2, 3, 4, 5]);
  });

  it('roundtrips a data frame with arbitrary bytes', () => {
    const payload = new Uint8Array(256);
    for (let i = 0; i < 256; i++) payload[i] = i;
    const decoded = decodeFrame(encodeFrame({ t: 'data', payload }));
    expect(decoded.t).toBe('data');
    expect(decoded.payload).toEqual(payload);
  });

  it('roundtrips an err frame with empty payload', () => {
    const decoded = decodeFrame(encodeFrame({ t: 'err', payload: new Uint8Array(0) }));
    expect(decoded.t).toBe('err');
    expect(decoded.payload.length).toBe(0);
  });

  it('emits exactly the expected wire shape', () => {
    const wire = encodeFrame({ t: 'hs', payload: new Uint8Array([0xde, 0xad]) });
    const obj = JSON.parse(wire) as Record<string, unknown>;
    expect(obj).toEqual({ v: PROTOCOL_VERSION, t: 'hs', p: expect.any(String) });
    expect(typeof obj.p).toBe('string');
    // base64url of [0xde, 0xad] = "3q0" (no padding)
    expect(obj.p).toBe('3q0');
  });
});

describe('envelope decode — version rejection', () => {
  it('rejects v=1', () => {
    const raw = JSON.stringify({ v: 1, t: 'hs', p: '' });
    expectEnvelopeError(() => decodeFrame(raw), 'UNSUPPORTED_VERSION');
  });

  it('rejects v=3', () => {
    const raw = JSON.stringify({ v: 3, t: 'hs', p: '' });
    expectEnvelopeError(() => decodeFrame(raw), 'UNSUPPORTED_VERSION');
  });

  it('rejects missing v', () => {
    const raw = JSON.stringify({ t: 'hs', p: '' });
    expectEnvelopeError(() => decodeFrame(raw), 'UNSUPPORTED_VERSION');
  });

  it('rejects v as string', () => {
    const raw = JSON.stringify({ v: '2', t: 'hs', p: '' });
    expectEnvelopeError(() => decodeFrame(raw), 'UNSUPPORTED_VERSION');
  });
});

describe('envelope decode — type rejection', () => {
  it('rejects unknown t', () => {
    const raw = JSON.stringify({ v: 2, t: 'unknown', p: '' });
    expectEnvelopeError(() => decodeFrame(raw), 'UNSUPPORTED_TYPE');
  });

  it('rejects missing t', () => {
    const raw = JSON.stringify({ v: 2, p: '' });
    expectEnvelopeError(() => decodeFrame(raw), 'UNSUPPORTED_TYPE');
  });
});

describe('envelope decode — payload rejection', () => {
  it('rejects non-string p', () => {
    const raw = JSON.stringify({ v: 2, t: 'hs', p: 123 });
    expectEnvelopeError(() => decodeFrame(raw), 'MALFORMED_FRAME');
  });

  it('rejects missing p', () => {
    const raw = JSON.stringify({ v: 2, t: 'hs' });
    expectEnvelopeError(() => decodeFrame(raw), 'MALFORMED_FRAME');
  });

  it('rejects standard base64 (with + or /)', () => {
    const raw = JSON.stringify({ v: 2, t: 'hs', p: 'ab+/' });
    expectEnvelopeError(() => decodeFrame(raw), 'MALFORMED_FRAME');
  });

  it('rejects non-base64 garbage', () => {
    const raw = JSON.stringify({ v: 2, t: 'hs', p: '!!!!' });
    expectEnvelopeError(() => decodeFrame(raw), 'MALFORMED_FRAME');
  });

  it('rejects oversized payload', () => {
    const big = new Uint8Array(2000);
    const raw = encodeFrame({ t: 'data', payload: big });
    expectEnvelopeError(() => decodeFrame(raw, 1000), 'FRAME_TOO_LARGE');
  });

  it('accepts payload exactly at limit', () => {
    const limit = 1000;
    const payload = new Uint8Array(limit);
    const raw = encodeFrame({ t: 'data', payload });
    const f = decodeFrame(raw, limit);
    expect(f.payload.length).toBe(limit);
  });
});

describe('envelope decode — JSON rejection', () => {
  it('rejects non-JSON', () => {
    expectEnvelopeError(() => decodeFrame('not-json'), 'MALFORMED_FRAME');
  });

  it('rejects JSON array', () => {
    expectEnvelopeError(() => decodeFrame('[1,2,3]'), 'MALFORMED_FRAME');
  });

  it('rejects JSON null', () => {
    expectEnvelopeError(() => decodeFrame('null'), 'MALFORMED_FRAME');
  });
});

describe('EnvelopeError', () => {
  it('exposes the correct closeCode', () => {
    try {
      decodeFrame(JSON.stringify({ v: 1, t: 'hs', p: '' }));
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvelopeError);
      expect((err as EnvelopeError).closeCode).toBe(WS_CLOSE.UNSUPPORTED_VERSION);
    }
  });
});

describe('base64url helpers', () => {
  it('roundtrips empty', () => {
    expect(fromBase64Url(toBase64Url(new Uint8Array(0))).length).toBe(0);
  });

  it('roundtrips all 256 byte values', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
  });

  it('encodes without padding', () => {
    // 1 byte would normally be encoded as "AA==" in padded base64
    const s = toBase64Url(new Uint8Array([0]));
    expect(s).toBe('AA');
    expect(s.includes('=')).toBe(false);
  });
});

describe('MAX_FRAME_APP_TO_AGENT', () => {
  it('is 256 KiB', () => {
    expect(MAX_FRAME_APP_TO_AGENT).toBe(256 * 1024);
  });
});

// ── helpers ────────────────────────────────────────────────────────

function expectEnvelopeError(fn: () => unknown, code: keyof typeof WS_CLOSE): void {
  try {
    fn();
    throw new Error(`expected throw with code ${code}`);
  } catch (err) {
    expect(err).toBeInstanceOf(EnvelopeError);
    expect((err as EnvelopeError).code).toBe(code);
  }
}
