#!/usr/bin/env node
/**
 * Generate a cross-language Noise IK interop fixture.
 *
 * Produces a JSON document containing:
 *
 *   - initiator static keypair (hex) — a freshly generated X25519 keypair
 *   - responder static keypair (hex) — same
 *   - prologue (hex)
 *   - initiator's handshake message 1 (hex)  ← what we send over the wire
 *   - initiator's expected msg1 payload (utf-8 JSON)
 *
 * Then drives the full handshake using the TS NoiseSession library and also
 * records:
 *
 *   - responder's handshake message 2 (hex)
 *   - responder's msg2 payload
 *   - a transport frame (initiator → responder) with its plaintext
 *   - a transport frame (responder → initiator) with its plaintext
 *
 * ### Reproducibility
 *
 * `noise-protocol`'s keygen does NOT accept a seed in v3.0.2. We can't produce
 * deterministic test vectors from a seed; instead this script generates a
 * fresh random keypair on each run and writes the RAW keypair bytes into the
 * fixture. The Dart test then loads those bytes and uses them verbatim, so the
 * fixture is a faithful self-contained record even though regenerating it
 * produces different bytes.
 *
 * ### What the Dart side must verify
 *
 *   1. Initialise a responder with the given responder privkey + prologue
 *   2. Accept msg1_hex → decrypted payload must equal msg1_payload_utf8
 *      AND peer static pubkey must equal the fixture's initiator static_public
 *   3. Decrypt init_to_resp_ciphertext_hex → matches init_to_resp_plaintext_utf8
 *   4. Encrypt its own "responder → initiator" frame (doesn't need to match
 *      the fixture's resp_to_init_ciphertext — nonces are sequential and
 *      the Dart encrypt call will produce a ciphertext with nonce 0, same
 *      as the TS side, so the two MUST match byte-for-byte; if they don't,
 *      the two sides disagree on nonce encoding or AEAD key derivation)
 *
 * Run: `node generate-fixture.mjs` → writes fixture.json next to this script.
 */

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import noiseLib from 'noise-protocol';

import {
  NoiseSession,
  NOISE_PROLOGUE,
} from '../../sdks/shepaw-acp-sdk-typescript/dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Fresh X25519 keypairs — recorded in the fixture so the Dart side can replay.
const initiatorKP = noiseLib.keygen();
const responderKP = noiseLib.keygen();

// NOTE: noise-protocol@3 does NOT support injecting ephemeral keys for IK
// (its `initialize` accepts `e` but the pattern's `TOK_E` handler asserts
// that `epk == null` at write time). So the TS side always generates fresh
// ephemerals. Cross-language interop is validated via:
//   - Dart responder consuming TS-generated msg1 (succeeds iff `es`, `s`, `ss`
//     all produce bit-identical handshake state on both sides)
//   - Both sides passing RFC primitive vectors (BLAKE2b, ChaCha20-Poly1305, X25519)

const prologue = NOISE_PROLOGUE;

const msg1PayloadText = '{"agentId":"acp_agent_test","clientVersion":"shepaw/dev"}';
const msg2PayloadText = '{"agentId":"acp_agent_test","serverVersion":"acp-sdk/2.0"}';

// IMPORTANT: the fixture *must* reflect both sides using the same prologue,
// the same static keys, and the same payloads — so we drive the handshake
// end-to-end before writing the file.

const initSess = NoiseSession.initiator({
  staticPublicKey: initiatorKP.publicKey,
  staticPrivateKey: initiatorKP.secretKey,
  remoteStaticPublicKey: responderKP.publicKey,
  prologue,
});
const respSess = NoiseSession.responder(
  {
    agentId: 'acp_agent_fixture',
    staticPublicKey: responderKP.publicKey,
    staticPrivateKey: responderKP.secretKey,
    fingerprint: '0000000000000000',
    createdAt: '1970-01-01T00:00:00Z',
    path: '/dev/null',
  },
  prologue,
);

const msg1 = initSess.writeHandshake1(Buffer.from(msg1PayloadText, 'utf-8'));
const hs1 = respSess.readHandshake1(msg1);
if (Buffer.from(hs1.msg1Payload).toString('utf-8') !== msg1PayloadText) {
  throw new Error('Internal inconsistency: msg1 payload mismatch');
}

const msg2 = respSess.writeHandshake2(Buffer.from(msg2PayloadText, 'utf-8'));
const hs2 = initSess.readHandshake2(msg2);
if (Buffer.from(hs2).toString('utf-8') !== msg2PayloadText) {
  throw new Error('Internal inconsistency: msg2 payload mismatch');
}

const initToRespText = 'hello from the initiator';
const initToRespCt = initSess.encrypt(Buffer.from(initToRespText, 'utf-8'));
const respToInitText = 'hello from the responder';
const respToInitCt = respSess.encrypt(Buffer.from(respToInitText, 'utf-8'));

// Sanity: both ciphertexts decrypt.
const decr1 = Buffer.from(respSess.decrypt(initToRespCt)).toString('utf-8');
const decr2 = Buffer.from(initSess.decrypt(respToInitCt)).toString('utf-8');
if (decr1 !== initToRespText || decr2 !== respToInitText) {
  throw new Error('Internal inconsistency: transport ciphertexts did not roundtrip');
}

function hex(u8) {
  return Buffer.from(u8).toString('hex');
}

const fixture = {
  _comment:
    'Cross-language Noise IK interop fixture. Suite: ' +
    'Noise_IK_25519_ChaChaPoly_BLAKE2b. Generated by TS SDK; consumed by the ' +
    'Dart SDK (shepaw/test/noise/noise_interop_test.dart). If the two halves ' +
    'ever disagree on any of these bytes, the wire protocol is incompatible.',
  suite: 'Noise_IK_25519_ChaChaPoly_BLAKE2b',
  prologue_hex: hex(prologue),
  initiator: {
    static_private_hex: hex(initiatorKP.secretKey),
    static_public_hex: hex(initiatorKP.publicKey),
    msg1_payload_utf8: msg1PayloadText,
    msg1_hex: hex(msg1),
  },
  responder: {
    static_private_hex: hex(responderKP.secretKey),
    static_public_hex: hex(responderKP.publicKey),
    msg2_payload_utf8: msg2PayloadText,
    msg2_hex: hex(msg2),
  },
  transport: {
    init_to_resp_plaintext_utf8: initToRespText,
    init_to_resp_ciphertext_hex: hex(initToRespCt),
    resp_to_init_plaintext_utf8: respToInitText,
    resp_to_init_ciphertext_hex: hex(respToInitCt),
  },
};

const outPath = resolve(__dirname, 'fixture.json');
writeFileSync(outPath, JSON.stringify(fixture, null, 2) + '\n');
// eslint-disable-next-line no-console
console.error(`Wrote ${outPath}`);
