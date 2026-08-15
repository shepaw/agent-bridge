/**
 * Product flags for surfaces we keep implementing but hide from operators.
 *
 * Gateway / ACP enroll (shepaw://pair + Channel) still works via CLI
 * (`shepaw-hub gateway pair`) and the APIs. The dashboard and app onboarding
 * default to Peer (`shepaw://peer`) until WAN / store issues are sorted.
 */
export const GATEWAY_PAIRING_UI = false;
