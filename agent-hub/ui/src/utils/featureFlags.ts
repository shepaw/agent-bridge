/**
 * Product flags for surfaces we keep implementing but hide from operators.
 *
 * Hides ACP/gateway enroll (`shepaw://pair` QR and per-instance tunnel
 * fields). Shared Channel for Peer remote access stays on the Pair device
 * tab. CLI: `shepaw-hub gateway pair`.
 */
export const GATEWAY_PAIRING_UI = false;
