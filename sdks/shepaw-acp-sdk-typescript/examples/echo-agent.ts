#!/usr/bin/env tsx
/**
 * Minimal ACP agent — wire-compatible with the Python `echo_agent.py`.
 *
 * Run:
 *   tsx examples/echo-agent.ts
 *
 * Then from the Shepaw app (or the Python `test_agent.py` in this repo):
 *   Address: ws://<your-ip>:8080/acp/ws
 *   Token:   my-secret
 */

import { ACPAgentServer, TaskContext } from '../src/index.js';

class EchoAgent extends ACPAgentServer {
  override async onChat(ctx: TaskContext, message: string): Promise<void> {
    await ctx.sendText(`Echo: ${message}`);
  }
}

const port = Number(process.env.PORT ?? '8080');
await new EchoAgent({ name: 'Echo Agent', token: 'my-secret' }).run({ port });
