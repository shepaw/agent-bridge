/**
 * Ephemeral ACP connection to list upstream agent sessions (session/list).
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';

import * as acp from '@agentclientprotocol/sdk';

import type { AcpEngineSpec } from './engines.js';
import { spawnCommand } from './engines.js';

export interface StoredSessionEntry {
  shepawSessionId: string;
  acpSessionId: string;
}

interface PersistedShape {
  version: 1;
  map: Record<string, string>;
}

export async function readStoredSessions(path: string): Promise<StoredSessionEntry[]> {
  try {
    const raw = await readFile(path, 'utf-8');
    const data = JSON.parse(raw) as Partial<PersistedShape>;
    if (data.version !== 1 || data.map === undefined || typeof data.map !== 'object') {
      return [];
    }
    return Object.entries(data.map)
      .filter(([, v]) => typeof v === 'string' && v.length > 0)
      .map(([shepawSessionId, acpSessionId]) => ({ shepawSessionId, acpSessionId }))
      .sort((a, b) => a.shepawSessionId.localeCompare(b.shepawSessionId));
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return [];
    throw err;
  }
}

export async function listUpstreamAcpSessions(
  spec: AcpEngineSpec,
  cwd: string,
  env?: Record<string, string | undefined>,
): Promise<acp.SessionInfo[]> {
  const { command, args } = spawnCommand(spec);
  const child = spawn(command, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });

  if (child.stdin === null || child.stdout === null) {
    throw new Error('ACP agent subprocess missing stdin/stdout pipes');
  }

  const input = Writable.toWeb(child.stdin);
  const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(input, output);

  const connection = acp
    .client({ name: 'shepaw-acp-proxy' })
    .connect(stream);

  try {
    await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: {
        name: 'shepaw-acp-proxy',
        title: 'Shepaw ACP Proxy',
        version: '0.2.0',
      },
    });

    const response = await connection.agent.request(acp.methods.agent.session.list, {
      cwd,
    }) as acp.ListSessionsResponse;

    return response.sessions ?? [];
  } finally {
    connection.close();
    if (!child.killed) child.kill('SIGTERM');
  }
}
