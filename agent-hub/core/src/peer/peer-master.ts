/**
 * Who holds the pouch backup.
 *
 * This hub's own master lives in hub config (`peer.masterFingerprint`).
 * A paired device naming this hub as its master is stored per device on the
 * pouch (`.masters/<device>.json`) and does not change this hub's choice.
 */

import { loadOrCreateHubConfig } from '../config.js';
import { hubStoreDeviceId } from './agent-store-mapping.js';
import { type PeerLocalStore } from './peer-local-store.js';

export function selfStoreDeviceId(): string {
  return hubStoreDeviceId().toLowerCase();
}

/** This hub's fingerprint, or null when the identity is not available yet. */
export function hubDeviceFingerprint(): string | null {
  try {
    return selfStoreDeviceId();
  } catch {
    return null;
  }
}

/**
 * Fingerprint of the other device this hub replicates to.
 * Null when this hub is its own master (unset, or set to itself).
 */
export function configuredRemoteMaster(): string | null {
  let self = '';
  try {
    self = selfStoreDeviceId();
  } catch {
    self = '';
  }
  const raw = loadOrCreateHubConfig().peer?.masterFingerprint?.toLowerCase();
  if (!raw || (self && raw === self)) return null;
  return raw;
}

export function resolveHubMaster(): { fingerprint: string; self: boolean } {
  const self = selfStoreDeviceId();
  const remote = configuredRemoteMaster();
  if (!remote) return { fingerprint: self, self: true };
  return { fingerprint: remote, self: false };
}

/** True when `caller` is the backup master of `device` and may read its private spaces. */
export function callerMayReadPrivate(
  store: PeerLocalStore,
  device: string,
  caller: string,
): boolean {
  const callerId = caller.trim().toLowerCase();
  const announced = store.announcedMaster(device);
  if (announced && announced === callerId) return true;
  let self = '';
  try {
    self = selfStoreDeviceId();
  } catch {
    return false;
  }
  if (device.trim().toLowerCase() !== self) return false;
  const master = configuredRemoteMaster();
  return master !== null && master === callerId;
}
