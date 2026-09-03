/**
 * Peer device name config: the name advertised to a phone when it pairs
 * (PairingResponse.device_name) defaults to the machine hostname and can be
 * overridden with `peer.deviceName` in hub.json.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadOrCreateHubConfig, resolvePeerDeviceName, setHubPeer } from '../src/config.js';

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'shepaw-hub-name-'));
  prevHome = process.env.SHEPAW_HUB_HOME;
  process.env.SHEPAW_HUB_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.SHEPAW_HUB_HOME;
  else process.env.SHEPAW_HUB_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe('peer device name config', () => {
  it('defaults to the machine hostname when unset', () => {
    expect(resolvePeerDeviceName()).toBe(hostname());
  });

  it('persists a custom device name through save/load', () => {
    setHubPeer(loadOrCreateHubConfig(), { deviceName: '  office-mac  ' });
    const reloaded = loadOrCreateHubConfig();
    expect(reloaded.peer?.deviceName).toBe('office-mac');
    expect(resolvePeerDeviceName(reloaded)).toBe('office-mac');
  });

  it('clearing deviceName restores the hostname default', () => {
    setHubPeer(loadOrCreateHubConfig(), { deviceName: 'office-mac' });
    setHubPeer(loadOrCreateHubConfig(), { deviceName: null });
    const reloaded = loadOrCreateHubConfig();
    expect(reloaded.peer?.deviceName).toBeUndefined();
    expect(resolvePeerDeviceName(reloaded)).toBe(hostname());
  });

  it('treats a whitespace-only deviceName as cleared', () => {
    setHubPeer(loadOrCreateHubConfig(), { deviceName: '   ' });
    const reloaded = loadOrCreateHubConfig();
    expect(reloaded.peer?.deviceName).toBeUndefined();
  });

  it('preserves deviceName when only host/port are patched (port relocation)', () => {
    const cfg = setHubPeer(loadOrCreateHubConfig(), { deviceName: 'office-mac' });
    setHubPeer(cfg, { port: 18794 });
    const reloaded = loadOrCreateHubConfig();
    expect(reloaded.peer?.deviceName).toBe('office-mac');
    expect(reloaded.peer?.port).toBe(18794);
  });
});
