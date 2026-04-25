/**
 * Integration test for v2.1 enrollment flow.
 *
 * A fresh peer (no pre-existing authorization) presents a single-use
 * enrollment code in its Noise msg1 payload. The server consumes the token,
 * writes the peer into `authorized_peers.json`, and completes the handshake.
 * A second connection (no enroll code) then succeeds because the pubkey is
 * now on the list.
 *
 * Also verifies the negative cases: invalid code → 4405, and re-use of the
 * same code by a different pubkey → 4405 on the second attempt.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import noiseLib from 'noise-protocol';

import { ACPAgentServer } from '../src/server.js';
import { TaskContext } from '../src/task-context.js';
import { WS_CLOSE } from '../src/envelope.js';
import { createEnrollmentToken, formatCodeForDisplay } from '../src/enrollments.js';
import { startAgent, V2TestClient } from './v2-test-client.js';

class EchoAgent extends ACPAgentServer {
  override async onChat(ctx: TaskContext, message: string): Promise<void> {
    await ctx.sendText(`Echo: ${message}`);
  }
}

describe('Enrollment-token handshake path', () => {
  let workdir: string;
  let peersPath: string;
  let enrollmentsPath: string;
  let agent: EchoAgent;
  let port: number;
  let stop: () => Promise<void>;

  beforeEach(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'shepaw-enroll-handshake-'));
    peersPath = join(workdir, 'authorized_peers.json');
    enrollmentsPath = join(workdir, 'enrollments.json');
    agent = new EchoAgent({ name: 'EnrollEcho', peersPath, enrollmentsPath });
    const handle = await startAgent(agent);
    port = handle.port;
    stop = handle.stop;
  });

  afterEach(async () => {
    await stop();
    rmSync(workdir, { recursive: true, force: true });
  });

  it('promotes a new peer into the allowlist on valid enroll code', async () => {
    const t = createEnrollmentToken(enrollmentsPath, { label: 'My iPhone' });
    const kp = noiseLib.keygen();

    const client = new V2TestClient(
      `ws://127.0.0.1:${port}/acp/ws?agentId=${agent.agentId}`,
      agent.identity.staticPublicKey,
      {
        agentId: agent.agentId,
        enroll: t.code,
        staticKeypair: { publicKey: kp.publicKey, privateKey: kp.secretKey },
      },
    );
    await client.waitReady();

    // Peers file now contains the new entry.
    const peersRaw = JSON.parse(readFileSync(peersPath, 'utf-8')) as {
      peers: Array<{ label: string; publicKey: string }>;
    };
    expect(peersRaw.peers.length).toBe(1);
    expect(peersRaw.peers[0]?.label).toBe('My iPhone');
    expect(peersRaw.peers[0]?.publicKey).toBe(
      Buffer.from(kp.publicKey).toString('base64'),
    );

    // Enrollments file no longer contains the consumed token.
    const enrollRaw = JSON.parse(readFileSync(enrollmentsPath, 'utf-8')) as {
      tokens: Array<{ code: string }>;
    };
    expect(enrollRaw.tokens.map((x) => x.code)).not.toContain(t.code);

    await client.close();
  });

  it('accepts display form XXX-XXX-XXX (server normalizes)', async () => {
    const t = createEnrollmentToken(enrollmentsPath);
    const kp = noiseLib.keygen();

    const client = new V2TestClient(
      `ws://127.0.0.1:${port}/acp/ws`,
      agent.identity.staticPublicKey,
      {
        agentId: agent.agentId,
        enroll: formatCodeForDisplay(t.code),
        staticKeypair: { publicKey: kp.publicKey, privateKey: kp.secretKey },
      },
    );
    await client.waitReady();
    await client.close();
  });

  it('second connection from the same peer succeeds WITHOUT an enroll code', async () => {
    const t = createEnrollmentToken(enrollmentsPath, { label: 'My iPhone' });
    const kp = noiseLib.keygen();

    // First connection: uses the code to enroll.
    const first = new V2TestClient(
      `ws://127.0.0.1:${port}/acp/ws`,
      agent.identity.staticPublicKey,
      {
        agentId: agent.agentId,
        enroll: t.code,
        staticKeypair: { publicKey: kp.publicKey, privateKey: kp.secretKey },
      },
    );
    await first.waitReady();
    await first.close();

    // Second connection: same keypair, no code, should just work.
    const second = new V2TestClient(
      `ws://127.0.0.1:${port}/acp/ws`,
      agent.identity.staticPublicKey,
      {
        agentId: agent.agentId,
        staticKeypair: { publicKey: kp.publicKey, privateKey: kp.secretKey },
      },
    );
    await second.waitReady();
    await second.close();
  });

  it('rejects connection with an unknown enroll code (4405)', async () => {
    const kp = noiseLib.keygen();
    const client = new V2TestClient(
      `ws://127.0.0.1:${port}/acp/ws`,
      agent.identity.staticPublicKey,
      {
        agentId: agent.agentId,
        enroll: 'NOTACODEX',
        staticKeypair: { publicKey: kp.publicKey, privateKey: kp.secretKey },
      },
    );

    const code = await client.waitForClose(2000);
    expect(code).toBe(WS_CLOSE.PEER_NOT_AUTHORIZED);

    // Peers file should still be empty.
    const peersRaw = JSON.parse(readFileSync(peersPath, 'utf-8')) as {
      peers: Array<unknown>;
    };
    expect(peersRaw.peers.length).toBe(0);
  });

  it('rejects second use of the same code (single-use)', async () => {
    const t = createEnrollmentToken(enrollmentsPath);

    // First client consumes.
    const kpA = noiseLib.keygen();
    const a = new V2TestClient(
      `ws://127.0.0.1:${port}/acp/ws`,
      agent.identity.staticPublicKey,
      {
        agentId: agent.agentId,
        enroll: t.code,
        staticKeypair: { publicKey: kpA.publicKey, privateKey: kpA.secretKey },
      },
    );
    await a.waitReady();
    await a.close();

    // Second client tries to re-use.
    const kpB = noiseLib.keygen();
    const b = new V2TestClient(
      `ws://127.0.0.1:${port}/acp/ws`,
      agent.identity.staticPublicKey,
      {
        agentId: agent.agentId,
        enroll: t.code,
        staticKeypair: { publicKey: kpB.publicKey, privateKey: kpB.secretKey },
      },
    );

    const code = await b.waitForClose(2000);
    expect(code).toBe(WS_CLOSE.PEER_NOT_AUTHORIZED);
  });
});
