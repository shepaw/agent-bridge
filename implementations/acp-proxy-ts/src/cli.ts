/**
 * CLI: `shepaw-acp-proxy serve --engine <name> [options]`
 */

import { cac } from 'cac';
import qrcode from 'qrcode-terminal';
import {
  ChannelTunnelConfig,
  addPeer,
  createEnrollmentToken,
  formatCodeForDisplay,
  loadOrCreateEnrollments,
  loadOrCreateIdentity,
  loadOrCreatePeers,
  removePeerByFingerprint,
  resolveEnrollmentsPath,
  resolveIdentityPath,
  resolvePeersPath,
  revokeEnrollmentToken,
} from 'shepaw-acp-sdk';

import { AcpProxyAgent } from './agent.js';
import {
  getBuiltinEngineSpec,
  listBuiltinEngineIds,
  resolveEngineSpec,
  spawnCommand,
  formatSpawnCommandLine,
} from './engines.js';
import { formatShellCommand } from './command-line.js';
import { listUpstreamAcpSessions, readStoredSessions } from './sessions-list.js';

if (process.argv[2] === 'peers' && typeof process.argv[3] === 'string' && !process.argv[3].startsWith('-')) {
  const sub = process.argv[3];
  process.argv.splice(2, 2, `peers-${sub}`);
}

const cli = cac('shepaw-acp-proxy');

cli
  .command('serve', 'Start the Shepaw ACP proxy gateway')
  .option('--engine <id>', `Engine id (built-in: ${listBuiltinEngineIds().join(', ')})`, {
    default: process.env.SHEPAW_ACP_ENGINE ?? 'claude-code',
  })
  .option('--engine-display-name <name>', 'Display name for custom engines')
  .option('--acp-command <cmd>', 'Upstream ACP spawn command (required for custom engines)')
  .option('--cwd <dir>', 'Working directory for the upstream agent', {
    default: process.cwd(),
  })
  .option('--port <port>', 'Port to listen on', {
    default: process.env.AGENT_PORT ?? 8090,
  })
  .option('--host <host>', 'Host to bind to', { default: '0.0.0.0' })
  .option('--name <name>', 'Display name shown in Shepaw')
  .option('--peers-path <path>', 'Override authorized_peers.json path')
  .option('--enrollments-path <path>', 'Override enrollments.json path')
  .option('--identity-path <path>', 'Override identity.json path')
  .option('--session-store-path <path>', 'Override sessions.json path')
  .option('--tunnel', 'Open reverse tunnel (PAW_ACP_TUNNEL_* env vars)')
  .option('--tunnel-server <url>', 'Channel Service base URL')
  .option('--tunnel-channel-id <id>', 'Channel ID')
  .option('--tunnel-secret <secret>', 'Channel secret')
  .option('--tunnel-endpoint <name>', 'Optional tunnel endpoint alias')
  .action(async (opts: {
    engine: string;
    engineDisplayName?: string;
    acpCommand?: string;
    cwd: string;
    port: string | number;
    host: string;
    name?: string;
    peersPath?: string;
    enrollmentsPath?: string;
    identityPath?: string;
    sessionStorePath?: string;
    tunnel?: boolean;
    tunnelServer?: string;
    tunnelChannelId?: string;
    tunnelSecret?: string;
    tunnelEndpoint?: string;
  }) => {
    const engine = String(opts.engine);

    let spec;
    try {
      spec = resolveEngineSpec(engine, {
        displayName: opts.engineDisplayName,
        acpCommand: opts.acpCommand,
      });
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    const port = Number(opts.port);

    let tunnelConfig: ChannelTunnelConfig | undefined;
    const serverUrl: string | undefined = opts.tunnelServer ?? process.env.PAW_ACP_TUNNEL_SERVER_URL;
    const channelId: string | undefined = opts.tunnelChannelId ?? process.env.PAW_ACP_TUNNEL_CHANNEL_ID;
    const secret: string | undefined = opts.tunnelSecret ?? process.env.PAW_ACP_TUNNEL_SECRET;
    const endpoint: string = opts.tunnelEndpoint ?? process.env.PAW_ACP_TUNNEL_ENDPOINT ?? '';
    const wantTunnel = Boolean(opts.tunnel) || Boolean(serverUrl && channelId && secret);
    if (wantTunnel) {
      if (!serverUrl || !channelId || !secret) {
        console.error('Tunnel requested but missing server URL, channel id, or secret.');
        process.exit(1);
      }
      tunnelConfig = await ChannelTunnelConfig.createWithAliasLookup({
        serverUrl,
        channelId,
        secret,
        channelEndpoint: endpoint,
      });
    }

    const agent = new AcpProxyAgent({
      engine,
      engineSpec: spec,
      name: opts.name ?? spec.defaultAgentName,
      cwd: opts.cwd,
      peersPath: opts.peersPath,
      enrollmentsPath: opts.enrollmentsPath,
      identityPath: opts.identityPath,
      sessionStoreOptions: opts.sessionStorePath ? { path: opts.sessionStorePath } : undefined,
      tunnelConfig,
    });

    console.log(`\nUpstream ACP agent: ${spec.displayName}`);
    const resolved = spawnCommand(spec, process.env);
    console.log(`  spawn: ${formatSpawnCommandLine(resolved.command, resolved.args)}\n`);

    try {
      await agent.init();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\nFailed to start upstream ACP agent: ${msg}`);
      if (engine === 'cursor') {
        console.error(
          'Cursor hint: run `cursor-agent login` or set a valid CURSOR_API_KEY ' +
            '(Cursor → Settings → Integrations → User API Keys).',
        );
      }
      process.exit(1);
    }
    await agent.run({ host: opts.host, port });
  });

cli
  .command('engines', 'List built-in upstream ACP agents')
  .action(() => {
    console.log('Built-in --engine values:\n');
    for (const id of listBuiltinEngineIds()) {
      const spec = getBuiltinEngineSpec(id);
      console.log(`  ${id.padEnd(14)}  ${spec.displayName}`);
      console.log(`  ${''.padEnd(14)}  ${formatShellCommand(spec.command, spec.args)}`);
    }
    console.log('\nCustom engines: register via Agent Hub or pass --acp-command on serve.\n');
  });

cli
  .command('peers-list', 'List authorized peer public keys')
  .option('--peers-path <path>', 'Override authorized_peers.json path')
  .action((opts: { peersPath?: string }) => {
    const path = resolvePeersPath(opts.peersPath);
    const peers = loadOrCreatePeers({ path });
    if (peers.peers.length === 0) {
      console.log(`No authorized peers. File: ${peers.path}`);
      return;
    }
    console.log(`Authorized peers (${peers.peers.length}) from ${peers.path}:`);
    for (const p of peers.peers) {
      console.log(`  ${p.fingerprint}  ${p.label || '(unlabeled)'}`);
    }
  });

cli
  .command('peers-add <pubkey>', 'Authorize a Shepaw app public key')
  .option('--label <label>', 'Human-readable label')
  .option('--peers-path <path>', 'Override authorized_peers.json path')
  .action((pubkey: string, opts: { label?: string; peersPath?: string }) => {
    const path = resolvePeersPath(opts.peersPath);
    try {
      const entry = addPeer(path, pubkey, opts.label);
      console.log(`Authorized peer ${entry.fingerprint} (${entry.label || '(unlabeled)'})`);
    } catch (err) {
      console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

cli
  .command('peers-remove <fingerprint>', 'Revoke a peer by 16-hex fingerprint')
  .option('--peers-path <path>', 'Override authorized_peers.json path')
  .action((fingerprint: string, opts: { peersPath?: string }) => {
    const path = resolvePeersPath(opts.peersPath);
    const removed = removePeerByFingerprint(path, fingerprint);
    if (!removed) {
      console.log(`No peer with fingerprint ${fingerprint}.`);
      process.exit(1);
    }
    console.log(`Removed peer ${fingerprint}.`);
  });

cli
  .command('enroll', 'Mint a single-use pairing code')
  .option('--label <label>', 'Label for the redeeming device')
  .option('--ttl-minutes <min>', 'Code TTL in minutes', { default: 10 })
  .option('--peers-path <path>', 'Override authorized_peers.json path')
  .option('--enrollments-path <path>', 'Override enrollments.json path')
  .option('--identity-path <path>', 'Override identity.json path')
  .option('--base-url <url>', 'Base WS URL for QR pairing')
  .option('--no-qr', 'Suppress terminal QR code')
  .action((opts: {
    label?: string;
    ttlMinutes?: number;
    peersPath?: string;
    enrollmentsPath?: string;
    identityPath?: string;
    baseUrl?: string;
    qr?: boolean;
  }) => {
    const enrollmentsPath = resolveEnrollmentsPath(opts.enrollmentsPath);
    const identity = loadOrCreateIdentity({ path: resolveIdentityPath(opts.identityPath) });
    const ttlMs = Math.max(1, Math.floor(Number(opts.ttlMinutes ?? 10))) * 60 * 1000;
    const token = createEnrollmentToken(enrollmentsPath, { label: opts.label, ttlMs });
    const display = formatCodeForDisplay(token.code);

    let pairUrl: string | undefined;
    if (opts.baseUrl) {
      const base = opts.baseUrl.replace(/\/$/, '');
      pairUrl = `${base}/acp/ws?agentId=${identity.agentId}#fp=${identity.fingerprint}`;
    }

    console.log(`\nPairing code: ${display}`);
    console.log(`Valid until: ${new Date(token.expiresAt).toLocaleString()}`);
    console.log(`Agent ID:    ${identity.agentId}`);
    console.log(`Fingerprint: ${identity.fingerprint}`);
    if (pairUrl) console.log(`Pair URL:    ${pairUrl}`);

    if (pairUrl && opts.qr !== false) {
      const qrPayload = `shepaw://pair?url=${encodeURIComponent(pairUrl)}&code=${encodeURIComponent(token.code)}`;
      qrcode.generate(qrPayload, { small: true }, (qr: string) => process.stdout.write(qr));
    }
    console.log('');
  });

cli
  .command('enroll-list', 'Show outstanding pairing codes')
  .option('--enrollments-path <path>', 'Override enrollments.json path')
  .action((opts: { enrollmentsPath?: string }) => {
    const store = loadOrCreateEnrollments({ path: resolveEnrollmentsPath(opts.enrollmentsPath) });
    if (store.tokens.length === 0) {
      console.log('No outstanding pairing codes.');
      return;
    }
    for (const t of store.tokens) {
      console.log(`${formatCodeForDisplay(t.code)}  expires ${new Date(t.expiresAt).toLocaleString()}  ${t.label ?? ''}`);
    }
  });

cli
  .command('enroll-revoke <code>', 'Revoke an unused pairing code')
  .option('--enrollments-path <path>', 'Override enrollments.json path')
  .action((code: string, opts: { enrollmentsPath?: string }) => {
    const ok = revokeEnrollmentToken(resolveEnrollmentsPath(opts.enrollmentsPath), code);
    process.exit(ok ? 0 : 1);
  });

cli
  .command('sessions list', 'List persisted Shepaw→ACP session mappings')
  .option('--session-store-path <path>', 'Path to sessions.json')
  .action(async (opts: { sessionStorePath?: string }) => {
    const path = opts.sessionStorePath ?? process.env.SHEPAW_SESSION_STORE_PATH;
    if (path === undefined || path.length === 0) {
      console.error('Provide --session-store-path or set SHEPAW_SESSION_STORE_PATH.');
      process.exit(1);
    }
    const entries = await readStoredSessions(path);
    if (entries.length === 0) {
      console.log(`No sessions in ${path}`);
      return;
    }
    for (const e of entries) {
      console.log(`${e.shepawSessionId}\t${e.acpSessionId}`);
    }
  });

cli
  .command('sessions acp-list', 'List upstream ACP agent sessions (session/list)')
  .option('--engine <id>', `Upstream ACP agent (${listBuiltinEngineIds().join(', ')})`, {
    default: process.env.SHEPAW_ACP_ENGINE ?? 'claude-code',
  })
  .option('--acp-command <cmd>', 'Upstream ACP spawn command (for custom engines)')
  .option('--cwd <dir>', 'Working directory filter', { default: process.cwd() })
  .action(async (opts: { engine: string; acpCommand?: string; cwd: string }) => {
    const engine = String(opts.engine);
    try {
      const spec = resolveEngineSpec(engine, { acpCommand: opts.acpCommand });
      const sessions = await listUpstreamAcpSessions(spec, opts.cwd);
      if (sessions.length === 0) {
        console.log('No upstream ACP sessions.');
        return;
      }
      console.log(JSON.stringify(sessions, null, 2));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

cli.help((sections) => {
  for (const s of sections) {
    if (typeof s.body === 'string') {
      s.body = s.body.replace(/peers-(list|add|remove)/g, 'peers $1');
    }
  }
  return sections;
});

cli.version('0.1.0');
cli.parse();
