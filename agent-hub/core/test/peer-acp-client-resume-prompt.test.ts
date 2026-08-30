/**
 * Real client ↔ real server contract test for the resume-prompt RPCs:
 * `agent.resume.promptSet` (set/clear the custom prompt without rebuilding)
 * and `agent.resume.rebuild` with an optional `prompt` param. The hub side
 * (PeerAcpClient.resumePromptSet / resumeRebuild) is driven against a REAL
 * in-process ACPAgentServer that records what actually arrived.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import type { WebSocketServer } from 'ws';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACPAgentServer,
  addPeer,
  loadOrCreateIdentity,
  type AgentCard,
  type ResumePromptSetParams,
  type ResumeRebuildParams,
} from 'shepaw-acp-sdk';

import { PeerAcpClient } from '../src/peer/peer-acp-client.js';
import type { InstanceConfig } from '../src/config.js';

class RecordingAgent extends ACPAgentServer {
  rebuildCalls: Array<ResumeRebuildParams | undefined> = [];
  promptCalls: Array<ResumePromptSetParams> = [];
  promptOverride: string | undefined;

  override async onResumeRebuild(params?: ResumeRebuildParams): Promise<AgentCard> {
    this.rebuildCalls.push(params);
    if (params?.prompt !== undefined) {
      this.promptOverride = params.prompt.length > 0 ? params.prompt : undefined;
    }
    return this.getAgentCard();
  }

  override async onResumePromptSet(params: ResumePromptSetParams): Promise<AgentCard> {
    this.promptCalls.push(params);
    this.promptOverride = params.prompt !== undefined && params.prompt.length > 0
      ? params.prompt
      : undefined;
    return this.getAgentCard();
  }
}

interface RunningServer {
  port: number;
  stop: () => Promise<void>;
}

async function startServer(agent: RecordingAgent, port = 0): Promise<RunningServer> {
  const { httpServer, wsServer } = agent.createServer() as {
    httpServer: HttpServer;
    wsServer: WebSocketServer;
  };
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  const bound = (httpServer.address() as AddressInfo).port;
  return {
    port: bound,
    stop: async () => {
      for (const client of wsServer.clients) {
        try { client.terminate(); } catch { /* ignore */ }
      }
      await new Promise<void>((resolve) => wsServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await agent.close().catch(() => undefined);
    },
  };
}

describe('PeerAcpClient resume-prompt RPC contract', () => {
  let workdir: string;
  let agent: RecordingAgent;
  let server: RunningServer;
  let client: PeerAcpClient;

  const instanceOf = (port: number): InstanceConfig =>
    ({
      id: 'alpha',
      label: 'Alpha',
      engine: 'claude-code',
      cwd: workdir,
      port,
      host: '127.0.0.1',
      baseUrl: '',
      extraArgs: [],
      createdAt: new Date().toISOString(),
    }) as unknown as InstanceConfig;

  beforeAll(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'shepaw-resume-prompt-'));
    const peersPath = join(workdir, 'authorized_peers.json');
    const identityPath = join(workdir, 'agent-identity.json');
    const peerIdentity = loadOrCreateIdentity({ path: join(workdir, 'peer-identity.json') });
    addPeer(peersPath, Buffer.from(peerIdentity.staticPublicKey).toString('base64'), 'hub');
    agent = new RecordingAgent({ name: 'Recording', peersPath, identityPath });
    server = await startServer(agent);
    client = new PeerAcpClient(peerIdentity, instanceOf(server.port), agent.identity, () => {});
  });

  afterAll(async () => {
    try { client.close(); } catch { /* ignore */ }
    await server.stop().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  });

  it('resumePromptSet delivers the prompt and resolves with the card', async () => {
    const card = await client.resumePromptSet('突出测试能力');
    expect(card).toBeDefined();
    expect(agent.promptCalls).toHaveLength(1);
    expect(agent.promptCalls[0]?.prompt).toBe('突出测试能力');
    expect(agent.promptOverride).toBe('突出测试能力');
  });

  it('resumePromptSet with an empty string clears the override', async () => {
    await client.resumePromptSet('');
    expect(agent.promptOverride).toBeUndefined();
  });

  it('resumeRebuild forwards the prompt param to the agent', async () => {
    const card = await client.resumeRebuild({ prompt: '重建时的新提示词' });
    expect(card).toBeDefined();
    expect(agent.rebuildCalls).toHaveLength(1);
    expect(agent.rebuildCalls[0]?.prompt).toBe('重建时的新提示词');
    expect(agent.promptOverride).toBe('重建时的新提示词');
  });

  it('resumeRebuild without params stays compatible (empty params object)', async () => {
    await client.resumeRebuild();
    expect(agent.rebuildCalls).toHaveLength(2);
    expect(agent.rebuildCalls[1]?.prompt).toBeUndefined();
  });
});
