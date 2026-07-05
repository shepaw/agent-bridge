/**
 * Authorize the device-level peer service identity on managed ACP agents.
 *
 * PeerAcpClient connects to each instance's loopback `/acp/ws` using the peer
 * service's long-term X25519 key (not the phone's). Instances must list that
 * pubkey in `authorized_peers.json` or every proxied chat fails with 4405.
 */

import { addPeer } from 'shepaw-acp-sdk';

import type { HubConfig } from '../config.js';
import { loadOrCreateHubConfig } from '../config.js';
import { instancePaths } from '../paths.js';
import { ensureInstanceDir } from '../spawn.js';
import { loadOrCreatePeerIdentity } from './peer-identity.js';

export const PEER_SERVICE_PEER_LABEL = 'shepaw-hub-peer-service';

/** Idempotently add the peer-service pubkey to one instance's allowlist. */
export function authorizePeerServiceOnInstance(
  instanceId: string,
  cfg: HubConfig = loadOrCreateHubConfig(),
): void {
  const instance = cfg.instances.find((p) => p.id === instanceId);
  if (instance === undefined) {
    throw new Error(`Unknown instance "${instanceId}".`);
  }
  ensureInstanceDir(instance.id);
  const peerIdentity = loadOrCreatePeerIdentity();
  const pubB64 = Buffer.from(peerIdentity.staticPublicKey).toString('base64');
  addPeer(instancePaths(instance.id).peersPath, pubB64, PEER_SERVICE_PEER_LABEL);
}

/** Idempotently authorize the peer service on every registered instance. */
export function authorizePeerServiceOnAllInstances(
  cfg: HubConfig = loadOrCreateHubConfig(),
): { instanceIds: string[]; fingerprint: string } {
  const peerIdentity = loadOrCreatePeerIdentity();
  const pubB64 = Buffer.from(peerIdentity.staticPublicKey).toString('base64');
  const instanceIds: string[] = [];

  for (const instance of cfg.instances) {
    ensureInstanceDir(instance.id);
    try {
      addPeer(instancePaths(instance.id).peersPath, pubB64, PEER_SERVICE_PEER_LABEL);
      instanceIds.push(instance.id);
    } catch (err) {
      throw new Error(
        `Failed to authorize peer service on instance "${instance.id}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { instanceIds, fingerprint: peerIdentity.fingerprint };
}
