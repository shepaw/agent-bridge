#!/usr/bin/env tsx
/**
 * Minimal ACP agent — wire-compatible with the Python `echo_agent.py`.
 *
 * Run:
 *   tsx examples/echo-agent.ts
 *
 * On first start a fresh X25519 identity is written to
 * `~/.config/shepaw-cb-gateway/identity.json`, and an empty allowlist appears
 * at `authorized_peers.json` alongside it. Authorize your Shepaw app's public
 * key by copying it from the app's "Add remote agent" screen and running the
 * gateway CLI:
 *
 *   shepaw-codebuddy-code peers add <base64-pubkey> --label "my phone"
 *
 * Then from the Shepaw app:
 *   Address: ws://<your-ip>:8080/acp/ws#fp=<fingerprint-from-banner>
 */

import { ACPAgentServer, TaskContext } from '../src/index.js';

class EchoAgent extends ACPAgentServer {
  override async onChat(ctx: TaskContext, message: string): Promise<void> {
    await ctx.sendText(`Echo: ${message}`);
  }
}

const port = Number(process.env.PORT ?? '8080');
await new EchoAgent({ name: 'Echo Agent' }).run({ port });
