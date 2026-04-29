/**
 * CLI entry point: `shepaw-claude-code <subcommand> [options]`.
 *
 * v2.1 subcommands:
 *   serve                       Start the gateway
 *   peers list                  Print authorized device public keys
 *   peers add <pubkey>          Authorize a Shepaw app to connect
 *   peers remove <fp>           Revoke a device by 16-hex fingerprint
 *   enroll                      Mint a single-use pairing code (short code + QR)
 *   enroll-list                 Show outstanding pairing codes
 *   enroll-revoke <code>        Cancel an unused pairing code
 *
 * Authentication is entirely by public-key allowlist (`authorized_peers.json`),
 * no `--token` flag exists anymore. See `shepaw-claude-code peers --help`.
 *
 * Implementation note: cac doesn't support multi-word command names; we
 * rewrite `peers <sub>` → `peers-<sub>` in argv before parsing, and rewrite
 * the help output back for display. See the matching comment in
 * codebuddy-code/src/cli.ts for the longer rationale.
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

import { ClaudeCodeAgent } from './agent.js';
import { mockQuery } from './mock-claude.js';

// See codebuddy-code/src/cli.ts for the rationale. Must mutate argv in place
// because cac snapshots `process.argv` at module-load time.
if (process.argv[2] === 'peers' && typeof process.argv[3] === 'string' && !process.argv[3].startsWith('-')) {
  const sub = process.argv[3];
  process.argv.splice(2, 2, `peers-${sub}`);
}

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
  .option('--name <name>', 'Display name', { default: 'Claude Code' })
  .option('--model <model>', 'Claude model id (e.g. claude-opus-4-7)')
  .option('--api-key <key>', 'API key for the LLM provider (sets ANTHROPIC_API_KEY for the subprocess)')
  .option('--api-base-url <url>', 'Base URL for the LLM provider API (sets ANTHROPIC_BASE_URL; e.g. https://openrouter.ai/api/v1)')
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
    '--peers-path <path>',
    'Override authorized_peers.json path (default: $SHEPAW_PEERS_PATH or ~/.config/shepaw-cb-gateway/authorized_peers.json)',
  )
  .option(
    '--enrollments-path <path>',
    'Override enrollments.json path (default: $SHEPAW_ENROLLMENTS_PATH or ~/.config/shepaw-cb-gateway/enrollments.json)',
  )
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
      peersPath: opts.peersPath,
      enrollmentsPath: opts.enrollmentsPath,
      cwd: opts.cwd,
      model: opts.model,
      apiKey: opts.apiKey,
      apiBaseUrl: opts.apiBaseUrl,
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

// ── peers subcommands ──────────────────────────────────────────────

cli
  .command('peers-list', 'List authorized peer public keys (apps that may connect)')
  .option('--peers-path <path>', 'Override authorized_peers.json path')
  .action((opts: { peersPath?: string }) => {
    const path = resolvePeersPath(opts.peersPath);
    const peers = loadOrCreatePeers({ path });
    if (peers.peers.length === 0) {
      console.log(`No authorized peers. File: ${peers.path}`);
      console.log('Add one with:  shepaw-claude-code peers add <pubkey> --label "my phone"');
      return;
    }
    console.log(`Authorized peers (${peers.peers.length}) from ${peers.path}:`);
    console.log();
    const rows = peers.peers.map((p) => ({
      fp: p.fingerprint,
      added: p.addedAt,
      label: p.label || '(unlabeled)',
    }));
    const fpW = 'FINGERPRINT'.length;
    const addedW = rows.reduce((m, r) => Math.max(m, r.added.length), 'ADDED'.length);
    const header = `  ${'FINGERPRINT'.padEnd(fpW)}  ${'ADDED'.padEnd(addedW)}  LABEL`;
    console.log(header);
    for (const r of rows) {
      console.log(`  ${r.fp.padEnd(fpW)}  ${r.added.padEnd(addedW)}  ${r.label}`);
    }
  });

cli
  .command(
    'peers-add <pubkey>',
    'Authorize an app by its base64-encoded 32-byte X25519 public key',
  )
  .option('--label <label>', 'Human-readable label (e.g. "my iPhone")')
  .option('--peers-path <path>', 'Override authorized_peers.json path')
  .action((pubkey: string, opts: { label?: string; peersPath?: string }) => {
    const path = resolvePeersPath(opts.peersPath);
    try {
      const entry = addPeer(path, pubkey, opts.label);
      console.log(`Authorized peer ${entry.fingerprint} (${entry.label || '(unlabeled)'})`);
      console.log(`File: ${path}`);
      console.log('If the agent is running, the change picks up within 100ms.');
    } catch (err) {
      console.error(`Failed to add peer: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

cli
  .command(
    'peers-remove <fingerprint>',
    'Revoke a peer by its 16-hex fingerprint. Any live session closes with WS 4411.',
  )
  .option('--peers-path <path>', 'Override authorized_peers.json path')
  .action((fingerprint: string, opts: { peersPath?: string }) => {
    const path = resolvePeersPath(opts.peersPath);
    const removed = removePeerByFingerprint(path, fingerprint);
    if (removed) {
      console.log(`Removed peer ${fingerprint} from ${path}.`);
      console.log('Any live session belonging to this peer will close within ~200ms.');
    } else {
      console.log(`No peer with fingerprint ${fingerprint} in ${path}.`);
      process.exit(1);
    }
  });

// ── enrollment subcommands ─────────────────────────────────────────
//
// Single-use pairing codes. Operator runs `enroll`, app scans the QR or
// types the short code, server consumes it at the next handshake and
// auto-adds the app's pubkey to authorized_peers.json. Codes travel inside
// the Noise-encrypted msg 1 payload — Channel Service sees AEAD ciphertext.

cli
  .command('enroll', 'Mint a single-use pairing code the Shepaw app can redeem on first connect')
  .option('--label <label>', 'Human-readable label for the device that will redeem the code')
  .option('--ttl-minutes <min>', 'Override token TTL (default: 10)', { default: 10 })
  .option('--peers-path <path>', 'Override authorized_peers.json path')
  .option('--enrollments-path <path>', 'Override enrollments.json path')
  .option('--identity-path <path>', 'Override identity.json path (to read agentId/fp)')
  .option('--base-url <url>', 'Base WS URL to print (e.g. wss://channel.example.com/c/my-agent). Defaults to printing a LAN hint only.')
  .option('--no-qr', 'Suppress the terminal QR code (useful for piping output)')
  .action((opts: {
    label?: string;
    ttlMinutes?: number;
    peersPath?: string;
    enrollmentsPath?: string;
    identityPath?: string;
    baseUrl?: string;
    qr?: boolean;  // cac inverts --no-qr into { qr: false }
  }) => {
    const enrollmentsPath = resolveEnrollmentsPath(opts.enrollmentsPath);
    const identity = loadOrCreateIdentity({ path: resolveIdentityPath(opts.identityPath) });

    const ttlMs = Math.max(1, Math.floor(Number(opts.ttlMinutes ?? 10))) * 60 * 1000;
    const token = createEnrollmentToken(enrollmentsPath, { label: opts.label, ttlMs });
    const display = formatCodeForDisplay(token.code);
    const expires = new Date(token.expiresAt).toLocaleString();

    // See codebuddy-code/src/cli.ts:enroll for the rationale on the
    // shepaw:// deep-link format. We only emit a QR when --base-url is
    // supplied — without a concrete host the QR would be useless or
    // actively misleading.
    let pairUrl: string | undefined;
    if (opts.baseUrl) {
      const base = opts.baseUrl.replace(/\/$/, '');
      pairUrl = `${base}/acp/ws?agentId=${identity.agentId}#fp=${identity.fingerprint}`;
    }
    const qrPayload = pairUrl
      ? `shepaw://pair?url=${encodeURIComponent(pairUrl)}&code=${encodeURIComponent(token.code)}`
      : undefined;

    console.log('');
    console.log('╭──────────────────────────────────────────────╮');
    console.log(`│  Pairing code:  ${display.padEnd(28, ' ')} │`);
    console.log('╰──────────────────────────────────────────────╯');
    console.log('');
    console.log(`  Valid until:  ${expires}`);
    console.log(`  Single use:   the code is invalidated after first handshake.`);
    console.log(`  Agent ID:     ${identity.agentId}`);
    console.log(`  Fingerprint:  ${identity.fingerprint}`);
    if (pairUrl) {
      console.log(`  Pair URL:     ${pairUrl}`);
    } else {
      console.log('');
      console.log('  In the Shepaw app:');
      console.log('    1. Tap "Add remote agent"');
      console.log('    2. Paste the URL printed on the agent banner (includes #fp=...)');
      console.log(`    3. Enter pairing code: ${display}`);
    }

    if (qrPayload && opts.qr !== false) {
      console.log('');
      console.log('  Scan with Shepaw app (or enter the code + URL manually):');
      console.log('');
      qrcode.generate(qrPayload, { small: true }, (qr: string) => {
        process.stdout.write(qr);
      });
    }

    console.log('');
    console.log(`  peers file:        ${resolvePeersPath(opts.peersPath)}`);
    console.log(`  enrollments file:  ${enrollmentsPath}`);
    console.log('');
  });

cli
  .command('enroll-list', 'Show outstanding pairing codes (expired ones are auto-pruned on read)')
  .option('--enrollments-path <path>', 'Override enrollments.json path')
  .action((opts: { enrollmentsPath?: string }) => {
    const enrollmentsPath = resolveEnrollmentsPath(opts.enrollmentsPath);
    const store = loadOrCreateEnrollments({ path: enrollmentsPath });
    if (store.tokens.length === 0) {
      console.log(`No outstanding pairing codes. File: ${store.path}`);
      console.log('Mint one with:  shepaw-claude-code enroll --label "my phone"');
      return;
    }
    console.log(`Outstanding pairing codes (${store.tokens.length}) in ${store.path}:`);
    console.log('');
    const rows = store.tokens.map((t) => ({
      code: formatCodeForDisplay(t.code),
      expires: new Date(t.expiresAt).toLocaleString(),
      label: t.label || '(unlabeled)',
    }));
    const codeW = Math.max(4, ...rows.map((r: { code: string }) => r.code.length));
    const expW = Math.max(7, ...rows.map((r: { expires: string }) => r.expires.length));
    console.log(`  ${'CODE'.padEnd(codeW)}  ${'EXPIRES'.padEnd(expW)}  LABEL`);
    for (const r of rows) {
      console.log(`  ${r.code.padEnd(codeW)}  ${r.expires.padEnd(expW)}  ${r.label}`);
    }
  });

cli
  .command(
    'enroll-revoke <code>',
    'Cancel an unused pairing code before it is redeemed',
  )
  .option('--enrollments-path <path>', 'Override enrollments.json path')
  .action((code: string, opts: { enrollmentsPath?: string }) => {
    const enrollmentsPath = resolveEnrollmentsPath(opts.enrollmentsPath);
    const ok = revokeEnrollmentToken(enrollmentsPath, code);
    if (ok) {
      console.log(`Revoked pairing code ${code} from ${enrollmentsPath}.`);
    } else {
      console.log(`No outstanding pairing code matching "${code}" in ${enrollmentsPath}.`);
      process.exit(1);
    }
  });

// Rewrite `peers-xxx` → `peers xxx` in help output so users see the
// documented command form, not the internal hyphen-namespaced form.
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
