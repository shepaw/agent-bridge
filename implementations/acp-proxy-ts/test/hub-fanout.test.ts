import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { addPeer, loadOrCreatePeers, removeEnrollmentTokenByCode } from 'shepaw-acp-sdk';

import { createHubFanoutHandler } from '../src/hub-fanout.js';

describe('createHubFanoutHandler', () => {
  let workdir: string;
  let peerA: string;
  let peerB: string;
  let enrollA: string;
  let enrollB: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'hub-fanout-'));
    peerA = join(workdir, 'a', 'authorized_peers.json');
    peerB = join(workdir, 'b', 'authorized_peers.json');
    enrollA = join(workdir, 'a', 'enrollments.json');
    enrollB = join(workdir, 'b', 'enrollments.json');
    process.env.SHEPAW_PEERS_PATH = peerA;
    process.env.SHEPAW_HUB_FANOUT_PEER_PATHS = `${peerA}\n${peerB}`;
    process.env.SHEPAW_HUB_FANOUT_ENROLLMENT_PATHS = `${enrollA}\n${enrollB}`;
  });

  afterEach(() => {
    delete process.env.SHEPAW_PEERS_PATH;
    delete process.env.SHEPAW_HUB_FANOUT_PEER_PATHS;
    delete process.env.SHEPAW_HUB_FANOUT_ENROLLMENT_PATHS;
    rmSync(workdir, { recursive: true, force: true });
  });

  it('adds peer to sibling projects and clears enrollment tokens', () => {
    const kp = Buffer.from('01234567890123456789012345678901', 'utf-8');
    const pubB64 = kp.toString('base64');

    // Bootstrap project already authorized via super.tryEnrollViaToken path.
    addPeer(peerA, pubB64, 'phone');

    const handler = createHubFanoutHandler();
    expect(handler).toBeDefined();
    handler!({
      publicKeyB64: pubB64,
      label: 'phone',
      code: 'ABCDEFGHJ',
    });

    const peersB = loadOrCreatePeers({ path: peerB });
    expect(peersB.peers).toHaveLength(1);
    expect(removeEnrollmentTokenByCode(enrollA, 'ABCDEFGHJ')).toBe(false);
    expect(removeEnrollmentTokenByCode(enrollB, 'ABCDEFGHJ')).toBe(false);
  });
});
