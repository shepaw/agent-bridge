/**
 * Local terminal proxy for ACP client terminal/* methods.
 *
 * Agents delegate shell execution to the client; on Shepaw the gateway host
 * runs commands and returns stdout/stderr to the upstream agent.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type * as acp from '@agentclientprotocol/sdk';

interface TerminalRecord {
  readonly id: string;
  readonly proc: ChildProcessWithoutNullStreams;
  output: string;
  truncated: boolean;
  exitStatus: acp.TerminalExitStatus | null;
  byteLimit: number;
}

export class TerminalHost {
  private readonly terminals = new Map<string, TerminalRecord>();

  create(params: acp.CreateTerminalRequest): acp.CreateTerminalResponse {
    const terminalId = randomUUID();
    const byteLimit = params.outputByteLimit ?? 256 * 1024;

    const proc = spawn(params.command, params.args ?? [], {
      cwd: params.cwd ?? undefined,
      env: envRecord(params.env),
      shell: process.platform === 'win32',
    });

    const record: TerminalRecord = {
      id: terminalId,
      proc,
      output: '',
      truncated: false,
      exitStatus: null,
      byteLimit,
    };

    const append = (chunk: Buffer): void => {
      if (record.exitStatus !== null) return;
      record.output += chunk.toString('utf-8');
      if (Buffer.byteLength(record.output, 'utf-8') > record.byteLimit) {
        record.truncated = true;
        while (Buffer.byteLength(record.output, 'utf-8') > record.byteLimit) {
          record.output = record.output.slice(Math.ceil(record.output.length * 0.1));
        }
      }
    };

    proc.stdout.on('data', append);
    proc.stderr.on('data', append);
    proc.on('close', (code, signal) => {
      record.exitStatus = {
        exitCode: code,
        signal: signal ?? null,
      };
    });

    this.terminals.set(terminalId, record);
    return { terminalId };
  }

  output(params: acp.TerminalOutputRequest): acp.TerminalOutputResponse {
    const record = this.require(params.terminalId);
    return {
      output: record.output,
      truncated: record.truncated,
      exitStatus: record.exitStatus,
    };
  }

  async waitForExit(params: acp.WaitForTerminalExitRequest): Promise<acp.WaitForTerminalExitResponse> {
    const record = this.require(params.terminalId);
    if (record.exitStatus !== null) {
      return {
        exitCode: record.exitStatus.exitCode,
        signal: record.exitStatus.signal,
      };
    }
    await new Promise<void>((resolve) => {
      record.proc.once('close', () => resolve());
    });
    const status = record.exitStatus ?? { exitCode: null, signal: null };
    return { exitCode: status.exitCode, signal: status.signal };
  }

  kill(params: acp.KillTerminalRequest): acp.KillTerminalResponse {
    const record = this.require(params.terminalId);
    try {
      record.proc.kill('SIGTERM');
    } catch {
      /* already dead */
    }
    return {};
  }

  release(params: acp.ReleaseTerminalRequest): acp.ReleaseTerminalResponse {
    const record = this.terminals.get(params.terminalId);
    if (record !== undefined) {
      try {
        if (record.exitStatus === null) record.proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      this.terminals.delete(params.terminalId);
    }
    return {};
  }

  disposeAll(): void {
    for (const id of [...this.terminals.keys()]) {
      this.release({ sessionId: '', terminalId: id });
    }
  }

  private require(terminalId: string): TerminalRecord {
    const record = this.terminals.get(terminalId);
    if (record === undefined) {
      throw new Error(`Unknown terminal: ${terminalId}`);
    }
    return record;
  }
}

function envRecord(vars: ReadonlyArray<acp.EnvVariable> | undefined): NodeJS.ProcessEnv {
  if (vars === undefined || vars.length === 0) return { ...process.env };
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const v of vars) env[v.name] = v.value;
  return env;
}
