/**
 * CLI entry point: `shepaw-claude-code serve [options]`.
 */

import { cac } from 'cac';
import { ChannelTunnelConfig } from 'shepaw-acp-sdk';

import { ClaudeCodeAgent } from './agent.js';
import { mockQuery } from './mock-claude.js';

const cli = cac('shepaw-claude-code');

cli
  .command('serve', 'Start the Shepaw Claude Code gateway on a WebSocket port')
  .option('--cwd <dir>', 'Working directory for Claude Code', {
    default: process.cwd(),
  })
  .option('--port <port>', 'Port to listen on', {
    default: process.env.AGENT_PORT ?? 8090,
  })
  .option('--host <host>', 'Host to bind to', { default: '0.0.0.0' })
  .option('--token <token>', 'Auth token (empty = no auth)', {
    default: process.env.AGENT_TOKEN ?? '',
  })
  .option('--agent-id <id>', 'Agent ID (default: auto-generated)')
  .option('--name <name>', 'Display name', { default: 'Claude Code' })
  .option('--model <model>', 'Claude model id (e.g. claude-opus-4-7)')
  .option('--max-turns <n>', 'Maximum agentic turns per chat')
  .option(
    '--allowed-tools <list>',
    'Comma-separated list of allowed tools (default: all)',
  )
  .option(
    '--permission-mode <mode>',
    'Permission mode (default | acceptEdits | plan | bypassPermissions)',
    { default: 'default' },
  )
  .option('--system-prompt <text>', 'Extra system prompt')
  .option(
    '--session-store-path <path>',
    'Override session store path (default: ~/.config/shepaw-cc-gateway/sessions.json)',
  )
  .option(
    '--tunnel',
    'Open a reverse tunnel to the Shepaw Channel Service. Reads PAW_ACP_TUNNEL_* env vars.',
  )
  .option('--tunnel-server <url>', 'Channel Service base URL (or PAW_ACP_TUNNEL_SERVER_URL)')
  .option('--tunnel-channel-id <id>', 'Channel ID (or PAW_ACP_TUNNEL_CHANNEL_ID)')
  .option('--tunnel-secret <secret>', 'Channel secret (or PAW_ACP_TUNNEL_SECRET)')
  .option('--tunnel-endpoint <name>', 'Optional short-name endpoint (or PAW_ACP_TUNNEL_ENDPOINT)')
  .option(
    '--mock',
    'Use a scripted fake Claude (no ANTHROPIC_API_KEY required). Send "help" from the app for scenarios.',
  )
  .action(async (opts) => {
    const port = Number(opts.port);
    const allowedTools =
      typeof opts.allowedTools === 'string' && opts.allowedTools.length > 0
        ? opts.allowedTools
            .split(',')
            .map((s: string) => s.trim())
            .filter(Boolean)
        : undefined;

    // Resolve tunnel config from flags, then fall back to env vars.
    let tunnelConfig: ChannelTunnelConfig | undefined;
    const serverUrl: string | undefined = opts.tunnelServer ?? process.env.PAW_ACP_TUNNEL_SERVER_URL;
    const channelId: string | undefined = opts.tunnelChannelId ?? process.env.PAW_ACP_TUNNEL_CHANNEL_ID;
    const secret: string | undefined = opts.tunnelSecret ?? process.env.PAW_ACP_TUNNEL_SECRET;
    const endpoint: string = opts.tunnelEndpoint ?? process.env.PAW_ACP_TUNNEL_ENDPOINT ?? '';
    const wantTunnel = Boolean(opts.tunnel) || Boolean(serverUrl && channelId && secret);
    if (wantTunnel) {
      if (!serverUrl || !channelId || !secret) {
        console.error(
          'Tunnel requested but missing --tunnel-server / --tunnel-channel-id / --tunnel-secret\n' +
            '(or PAW_ACP_TUNNEL_SERVER_URL / PAW_ACP_TUNNEL_CHANNEL_ID / PAW_ACP_TUNNEL_SECRET).',
        );
        process.exit(1);
      }
      tunnelConfig = new ChannelTunnelConfig({
        serverUrl,
        channelId,
        secret,
        channelEndpoint: endpoint,
      });
    }

    const agent = new ClaudeCodeAgent({
      name: opts.name,
      token: opts.token,
      agentId: opts.agentId,
      cwd: opts.cwd,
      model: opts.model,
      maxTurns: opts.maxTurns !== undefined ? Number(opts.maxTurns) : undefined,
      allowedTools,
      permissionMode: opts.permissionMode,
      systemPrompt: opts.systemPrompt,
      sessionStoreOptions: opts.sessionStorePath
        ? { path: opts.sessionStorePath }
        : undefined,
      tunnelConfig,
      queryFn: opts.mock ? mockQuery : undefined,
    });

    if (opts.mock) {
      console.log(
        '\n[mock] Running without Claude API. Send "help" from the app to see scripted scenarios.\n',
      );
    }

    await agent.init();
    await agent.run({ host: opts.host, port });
  });

cli.help();
cli.version('0.1.0');

cli.parse();
