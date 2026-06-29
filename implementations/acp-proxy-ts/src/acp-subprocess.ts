/**
 * Manages a long-lived ACP agent subprocess and ClientConnection.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable, Writable } from 'node:stream';

import * as acp from '@agentclientprotocol/sdk';
import { TaskCancelledError } from 'shepaw-acp-sdk';
import type { TaskContext } from 'shepaw-acp-sdk';

import type { AcpEngineSpec } from './engines.js';
import { spawnCommand } from './engines.js';
import { log } from './debug.js';
import { mapSessionUpdate } from './session-mapper.js';

export interface TurnContext {
  readonly taskCtx: TaskContext;
  readonly signal: AbortSignal;
}

export interface AcpSubprocessOptions {
  readonly spec: AcpEngineSpec;
  readonly cwd: string;
  readonly env?: Record<string, string | undefined>;
}

export class AcpSubprocess {
  private readonly spec: AcpEngineSpec;
  private readonly cwd: string;
  private readonly extraEnv: Record<string, string | undefined>;

  private child: ChildProcess | undefined;
  private connection: acp.ClientConnection | undefined;
  private initPromise: Promise<void> | undefined;
  private agentCaps: acp.InitializeResponse | undefined;

  /** Active ACP sessions keyed by Shepaw session_id. */
  private readonly sessions = new Map<string, acp.ActiveSession>();

  /** Current in-flight turn — used by permission/fs handlers. */
  private currentTurn: TurnContext | undefined;

  /** Cached slash commands from the latest available_commands_update. */
  private cachedCommands: acp.AvailableCommand[] = [];

  constructor(opts: AcpSubprocessOptions) {
    this.spec = opts.spec;
    this.cwd = opts.cwd;
    this.extraEnv = opts.env ?? {};
  }

  get capabilities(): acp.InitializeResponse | undefined {
    return this.agentCaps;
  }

  get availableCommands(): ReadonlyArray<acp.AvailableCommand> {
    return this.cachedCommands;
  }

  /** Start the subprocess and initialize the ACP connection. */
  async start(): Promise<void> {
    if (this.initPromise !== undefined) {
      return this.initPromise;
    }
    this.initPromise = this.doStart();
    return this.initPromise;
  }

  private async doStart(): Promise<void> {
    const { command, args } = spawnCommand(this.spec);
    log('spawning ACP agent: %s %s (cwd=%s)', command, args.join(' '), this.cwd);

    const child = spawn(command, args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...this.extraEnv,
      },
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8').trim();
      if (text.length > 0) log('agent stderr: %s', text);
    });

    child.on('exit', (code, signal) => {
      log('ACP agent exited code=%s signal=%s', code, signal);
      this.connection?.close(new Error(`ACP agent exited (${code ?? signal})`));
      this.connection = undefined;
      this.child = undefined;
      this.initPromise = undefined;
      for (const session of this.sessions.values()) {
        session.dispose();
      }
      this.sessions.clear();
    });

    if (child.stdin === null || child.stdout === null) {
      throw new Error('ACP agent subprocess missing stdin/stdout pipes');
    }

    this.child = child;

    const input = Writable.toWeb(child.stdin);
    const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);

    const clientApp = acp
      .client({ name: 'shepaw-acp-proxy' })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        this.handleRequestPermission(ctx.params, ctx.signal),
      )
      .onRequest(acp.methods.client.fs.readTextFile, (ctx) =>
        this.handleReadTextFile(ctx.params),
      )
      .onRequest(acp.methods.client.fs.writeTextFile, (ctx) =>
        this.handleWriteTextFile(ctx.params),
      );

    this.connection = clientApp.connect(stream);

    const initResult = await this.connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
      },
      clientInfo: {
        name: 'shepaw-acp-proxy',
        title: 'Shepaw ACP Proxy',
        version: '0.1.0',
      },
    });

    this.agentCaps = initResult;
    log(
      'ACP initialized: protocol v%s agent=%s',
      initResult.protocolVersion,
      initResult.agentInfo?.title ?? initResult.agentInfo?.name ?? 'unknown',
    );
  }

  async stop(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    this.connection?.close();
    this.connection = undefined;
    if (this.child !== undefined && !this.child.killed) {
      this.child.kill('SIGTERM');
    }
    this.child = undefined;
    this.initPromise = undefined;
  }

  /** Run one user prompt turn, streaming updates to TaskContext. */
  async runPromptTurn(
    shepawSessionId: string,
    message: string,
    turn: TurnContext,
    onAcpSessionCreated?: (acpSessionId: string) => void,
  ): Promise<void> {
    await this.start();
    if (this.connection === undefined) {
      throw new Error('ACP connection not established');
    }

    this.currentTurn = turn;

    try {
      const session = await this.getOrCreateSession(shepawSessionId, onAcpSessionCreated);

      const promptPromise = session.prompt(message);
      const updatesLoop = this.drainUpdates(session, turn);

      const abortPromise = new Promise<never>((_, reject) => {
        if (turn.signal.aborted) {
          reject(new TaskCancelledError());
          return;
        }
        turn.signal.addEventListener(
          'abort',
          () => {
            void this.cancelSession(session.sessionId);
            reject(new TaskCancelledError());
          },
          { once: true },
        );
      });

      await Promise.race([Promise.all([promptPromise, updatesLoop]), abortPromise]);
    } finally {
      this.currentTurn = undefined;
    }
  }

  private async getOrCreateSession(
    shepawSessionId: string,
    onCreated?: (acpSessionId: string) => void,
  ): Promise<acp.ActiveSession> {
    const existing = this.sessions.get(shepawSessionId);
    if (existing !== undefined) {
      return existing;
    }

    const agent = this.connection!.agent;
    const session = await agent.buildSession(this.cwd).start();
    this.sessions.set(shepawSessionId, session);
    onCreated?.(session.sessionId);
    log('created ACP session %s for shepaw session %s', session.sessionId, shepawSessionId);
    return session;
  }

  private async drainUpdates(
    session: acp.ActiveSession,
    turn: TurnContext,
  ): Promise<void> {
    for (;;) {
      if (turn.signal.aborted) {
        throw new TaskCancelledError();
      }

      const msg = await session.nextUpdate();
      if (msg.kind === 'stop') {
        log('prompt stopped: %s', msg.stopReason);
        return;
      }

      await mapSessionUpdate(msg.update, turn.taskCtx);

      if (msg.update.sessionUpdate === 'available_commands_update') {
        this.cachedCommands = msg.update.availableCommands ?? [];
      }
    }
  }

  private async cancelSession(sessionId: string): Promise<void> {
    try {
      await this.connection?.agent.notify(acp.methods.agent.session.cancel, { sessionId });
    } catch (err) {
      log('session/cancel failed: %s', err instanceof Error ? err.message : String(err));
    }
  }

  private async handleRequestPermission(
    params: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<acp.RequestPermissionResponse> {
    const turn = this.currentTurn;
    if (turn === undefined) {
      return { outcome: { outcome: 'cancelled' } };
    }

    const title = params.toolCall.title ?? params.toolCall.toolCallId ?? 'Permission requested';
    const actions =
      params.options.length > 0
        ? params.options.map((opt) => ({
            label: opt.name,
            value: opt.optionId,
          }))
        : [
            { label: 'Allow', value: 'allow' },
            { label: 'Deny', value: 'deny' },
          ];

    const confirmationId = await turn.taskCtx.sendActionConfirmation({
      prompt: title,
      actions,
    });

    try {
      const response = await turn.taskCtx.waitForResponse(confirmationId, {
        timeoutMs: 20 * 60 * 1000,
      });

      if (signal.aborted || turn.signal.aborted) {
        return { outcome: { outcome: 'cancelled' } };
      }

      const raw =
        (typeof response.action === 'string' && response.action) ||
        (typeof response.value === 'string' && response.value) ||
        (typeof response.selected === 'string' && response.selected) ||
        '';

      const matched = params.options.find(
        (opt) => opt.optionId === raw || opt.name.toLowerCase() === raw.toLowerCase(),
      );
      if (matched !== undefined) {
        return { outcome: { outcome: 'selected', optionId: matched.optionId } };
      }

      if (/^(allow|yes|ok|approve)/i.test(raw)) {
        const allowOpt =
          params.options.find((o) => /allow|yes|approve/i.test(o.name)) ?? params.options[0];
        if (allowOpt !== undefined) {
          return { outcome: { outcome: 'selected', optionId: allowOpt.optionId } };
        }
      }

      if (/^(deny|no|reject|cancel)/i.test(raw)) {
        const denyOpt = params.options.find((o) => /deny|no|reject/i.test(o.name));
        if (denyOpt !== undefined) {
          return { outcome: { outcome: 'selected', optionId: denyOpt.optionId } };
        }
        return { outcome: { outcome: 'cancelled' } };
      }

      return { outcome: { outcome: 'cancelled' } };
    } catch {
      return { outcome: { outcome: 'cancelled' } };
    }
  }

  private async handleReadTextFile(
    params: acp.ReadTextFileRequest,
  ): Promise<acp.ReadTextFileResponse> {
    const content = await readFile(params.path, 'utf-8');
    return { content };
  }

  private async handleWriteTextFile(
    params: acp.WriteTextFileRequest,
  ): Promise<acp.WriteTextFileResponse> {
    await mkdir(dirname(params.path), { recursive: true });
    await writeFile(params.path, params.content, 'utf-8');
    return {};
  }
}
