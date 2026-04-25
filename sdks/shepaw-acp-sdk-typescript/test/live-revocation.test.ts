/**
 * Live revocation test — v2.1 fs.watch behavior.
 *
 * A connected peer is forcibly disconnected with WS close 4411 (UNREGISTERED)
 * as soon as it's removed from `authorized_peers.json`. This matters: if a
 * user compromises a phone and the operator runs `peers remove <fp>`, the
 * phone's currently-open session must be torn down immediately — not "next
 * time it reconnects".
 *
 * Two paths into the same observable outcome:
 *   1. External CLI-style file edit → fs.watch fires → reloadPeers runs,
 *      debounced 100 ms.
 *   2. `peer.unregister` RPC from the app itself → handlePeerUnregister runs
 *      synchronously, calls reloadPeers directly.
 *
 * This file exercises path 1. Path 2 is already covered in server.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import noiseLib from 'noise-protocol';

import { ACPAgentServer } from '../src/server.js';
import { TaskContext } from '../src/task-context.js';
import { WS_CLOSE } from '../src/envelope.js';
import { addPeer, removePeerByFingerprint, derivedPeerFingerprint } from '../src/peers.js';
import { startAgent, V2TestClient } from './v2-test-client.js';

class EchoAgent extends ACPAgentServer {
  override async onChat(ctx: TaskContext, message: string): Promise<void> {
    await ctx.sendText(`Echo: ${message}`);
  }
}

describe('Live revocation (fs.watch)', () => {
  let workdir: string;
  let peersPath: string;
  let agent: EchoAgent;
  let port: number;
  let stop: () => Promise<void>;

  beforeEach(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'shepaw-live-revoke-'));
    peersPath = join(workdir, 'authorized_peers.json');
    agent = new EchoAgent({ name: 'RevokeEcho', peersPath });
    const handle = await startAgent(agent);
    port = handle.port;
    stop = handle.stop;
  });

  afterEach(async () => {
    await stop();
    rmSync(workdir, { recursive: true, force: true });
  });

  it('boots a connected session within ~200 ms when removed from the allowlist', async () => {
    const kp = noiseLib.keygen();
    const pubB64 = Buffer.from(kp.publicKey).toString('base64');
    addPeer(peersPath, pubB64, 'will-be-revoked');
    // The agent has been running — tell it the file changed. (In normal
    // operation, fs.watch handles this. During tests, we call reloadPeers
    // directly to avoid waiting on platform-specific watcher behavior for
    // the initial add.)
    agent['reloadPeers']();

    const client = new V2TestClient(
      `ws://127.0.0.1:${port}/acp/ws`,
      agent.identity.staticPublicKey,
      { staticKeypair: { publicKey: kp.publicKey, privateKey: kp.secretKey } },
    );
    await client.waitReady();

    // Sanity: chat works while authorized.
    const ack = await client.request('ping');
    expect(ack.result).toEqual({ pong: true });

    // Now revoke via the file. fs.watch is debounced 100 ms.
    const fp = derivedPeerFingerprint(kp.publicKey);
    const removed = removePeerByFingerprint(peersPath, fp);
    expect(removed).toBe(true);

    // Wait for the close. Debounce is 100 ms, allow 1500 ms of slop for slow CI.
    const code = await client.waitForClose(1500);
    expect(code).toBe(WS_CLOSE.UNREGISTERED);
  });

  it('removing a non-connected peer still updates the allowlist (idempotent)', async () => {
    // Even without any live session, the file edit must be picked up so that
    // the next connection from this peer is rejected.
    const kp1 = noiseLib.keygen();
    const kp2 = noiseLib.keygen();
    addPeer(peersPath, Buffer.from(kp1.publicKey).toString('base64'), 'alice');
    addPeer(peersPath, Buffer.from(kp2.publicKey).toString('base64'), 'bob');
    agent['reloadPeers']();
    expect(agent['peers'].peers.length).toBe(2);

    const fp1 = derivedPeerFingerprint(kp1.publicKey);
    removePeerByFingerprint(peersPath, fp1);

    // Give fs.watch time to fire. Use a generous margin.
    await new Promise((r) => setTimeout(r, 300));
    expect(agent['peers'].peers.length).toBe(1);
    expect(agent['peers'].peers[0]?.label).toBe('bob');
  });
});
