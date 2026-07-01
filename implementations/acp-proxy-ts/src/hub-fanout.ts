/**
 * Hub spawn sets SHEPAW_HUB_FANOUT_* env vars so a single device pairing
 * authorizes the app on every managed agent.
 */

import {
  addPeer,
  removeEnrollmentTokenByCode,
  type PeerEnrolledEvent,
} from 'shepaw-acp-sdk';

function splitPaths(raw: string | undefined): string[] {
  if (raw === undefined || raw.length === 0) return [];
  return raw.split('\n').map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Build the SDK hook when launched under shepaw-hub. */
export function createHubFanoutHandler(): ((event: PeerEnrolledEvent) => void) | undefined {
  const peerPaths = splitPaths(process.env.SHEPAW_HUB_FANOUT_PEER_PATHS);
  if (peerPaths.length === 0) return undefined;

  const enrollmentPaths = splitPaths(process.env.SHEPAW_HUB_FANOUT_ENROLLMENT_PATHS);
  const ownPeersPath = process.env.SHEPAW_PEERS_PATH;

  return (event) => {
    for (const path of peerPaths) {
      if (ownPeersPath !== undefined && path === ownPeersPath) continue;
      addPeer(path, event.publicKeyB64, event.label);
    }
    for (const path of enrollmentPaths) {
      removeEnrollmentTokenByCode(path, event.code);
    }
  };
}
