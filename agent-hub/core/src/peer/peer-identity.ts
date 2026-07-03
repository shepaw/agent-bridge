/**
 * Long-term X25519 identity for the device-level peer service.
 *
 * The peer service is the `shepaw://peer` responder: phones pin its static
 * public key from the pairing QR (`#pk=`) and perform a Noise IK handshake.
 * The keypair is persisted at `~/.config/shepaw-hub/peer-identity.json` so the
 * fingerprint stays stable across restarts (paired phones would otherwise have
 * to re-pair after every hub restart).
 *
 * We reuse the SDK's `loadOrCreateIdentity` (same X25519 keypair + SHA-256
 * fingerprint scheme the ACP agents use) but at a dedicated path — the peer
 * identity is deliberately distinct from any ACP agent identity.
 */

import { loadOrCreateIdentity, type AgentIdentity } from 'shepaw-acp-sdk';
import { peerIdentityPath } from '../paths.js';

/** Load (or create) the peer service's long-term X25519 identity. */
export function loadOrCreatePeerIdentity(): AgentIdentity {
  return loadOrCreateIdentity({ path: peerIdentityPath() });
}
