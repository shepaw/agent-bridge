/**
 * CLI entry point: `shepaw-hub <subcommand> [options]`.
 *
 * Subcommand map:
 *
 *   init                           Initialize ~/.config/shepaw-hub/ (idempotent)
 *
 *   project add <id>               Register a new project
 *   project list                   List registered projects
 *   project show <id>              Detailed info for one project
 *   project remove <id>            Unregister; stops first if running
 *   project update <id>            Patch label / baseUrl / extraArgs / host / cwd
 *
 *   start <id>                     Spawn the gateway process (detached)
 *   stop <id>                      Stop the gateway (SIGTERM on Unix, TerminateProcess on Windows)
 *   status [<id>]                  Show running state (all projects if no id)
 *   logs <id>                      Tail the gateway's stdout/stderr
 *   logs rotate <id>               Force log rotation
 *
 *   pair <id>                      Mint an enroll code, print QR + short code.
 *   enroll <id>                    Same as pair; preserved for consistency with gateway CLIs.
 *   enroll-list <id>               List this project's outstanding codes
 *   enroll-revoke <id> <code>      Cancel an unused code
 *
 *   peers list <id>                List authorized peers for a project
 *   peers add <id> <pubkey>        Authorize a device
 *   peers remove <id> <fp>         Revoke a device
 *
 *   web [--port <n>]               Start the web dashboard (API + UI)
 */

import { existsSync } from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';

import { cac } from 'cac';
import qrcode from 'qrcode-terminal';
import {
  addPeer as sdkAddPeer,
  createEnrollmentToken,
  formatCodeForDisplay,
  loadOrCreateEnrollments,
  loadOrCreateIdentity,
  loadOrCreatePeers,
  removePeerByFingerprint as sdkRemovePeer,
  revokeEnrollmentToken,
} from 'shepaw-acp-sdk';

import {
  addProject,
  findProject,
  getProject,
  loadOrCreateHubConfig,
  ProjectExistsError,
  ProjectNotFoundError,
  type AgentEngine,
  type ProjectConfig,
  type TunnelConfig,
} from '@shepaw/agent-hub-core';
import {
  ensureProjectDir,
  isAlive,
  readState,
  rotateProjectLogs,
  startProject,
  stopProject,
} from '@shepaw/agent-hub-core';
import { nextFreePort } from '@shepaw/agent-hub-core';
import { projectPaths, hubRoot, hubConfigPath } from '@shepaw/agent-hub-core';
import { tailLog } from '@shepaw/agent-hub-core';
import { updateProject } from '@shepaw/agent-hub-core';

// ── multi-word dispatch ────────────────────────────────────────────
const multiWord = new Set(['project', 'peers', 'logs', 'enroll']);
if (
  process.argv.length >= 4 &&
  typeof process.argv[2] === 'string' &&
  typeof process.argv[3] === 'string' &&
  multiWord.has(process.argv[2]) &&
  !process.argv[3].startsWith('-')
) {
  const outer = process.argv[2];
  const inner = process.argv[3];
  process.argv.splice(2, 2, `${outer}-${inner}`);
}

const cli = cac('shepaw-hub');

// ── init ───────────────────────────────────────────────────────────

cli
  .command('init', 'Create ~/.config/shepaw-hub/ and hub.json (idempotent)')
  .action(() => {
    const cfg = loadOrCreateHubConfig();
    console.log(`Hub config:   ${cfg.path}`);
    console.log(`Hub root:     ${hubRoot()}`);
    console.log(`Projects:     ${cfg.projects.length}`);
    if (cfg.projects.length === 0) {
      console.log('');
      console.log('Next: register a project');
      console.log('  shepaw-hub project add my-project --engine codebuddy --cwd /path/to/code');
    }
  });

// ── project management ─────────────────────────────────────────────

cli
  .command('project-add <id>', 'Register a new agent project')
  .option('--engine <engine>', 'Gateway engine: codebuddy | claude-code | tclaude | codex | tcodex | opencode | openclaw | cursor | hermes', { default: 'codebuddy' })
  .option('--cwd <dir>', 'Working directory for the gateway', { default: process.cwd() })
  .option('--label <text>', 'Display name shown in `status`')
  .option('--port <n>', 'Bind port (default: next free port from 8090)')
  .option('--host <host>', 'Bind host (default: 127.0.0.1; use 0.0.0.0 for LAN)', { default: '127.0.0.1' })
  .option('--base-url <url>', 'Base WS URL for pairing QRs (overrides tunnel-derived URL)')
  .option('--tunnel-server <url>', 'Shepaw Channel Service base URL')
  .option('--tunnel-channel-id <id>', 'Channel ID for this project')
  .option('--tunnel-secret <secret>', 'HMAC-SHA256 signing secret for this channel')
  .option('--extra-arg <arg>', 'Extra argument passed through to gateway serve (repeatable)', { default: [] })
  .option('--env <KEY=VALUE>', 'Set a project env var, e.g. ANTHROPIC_API_KEY=sk-... (repeatable)', { default: [] })
  .action(async (id: string, opts: {
    engine: string;
    cwd: string;
    label?: string;
    port?: number | string;
    host: string;
    baseUrl?: string;
    tunnelServer?: string;
    tunnelChannelId?: string;
    tunnelSecret?: string;
    extraArg?: string | string[];
    env?: string | string[];
  }) => {
    try {
      const cfg = loadOrCreateHubConfig();
      const engine = parseEngine(opts.engine);
      const reservedPorts = cfg.projects.map((p) => p.port);
      const port = opts.port !== undefined
        ? Number(opts.port)
        : await nextFreePort({ reserved: reservedPorts });

      const extraArgs = Array.isArray(opts.extraArg)
        ? opts.extraArg.filter((s): s is string => typeof s === 'string')
        : typeof opts.extraArg === 'string'
          ? [opts.extraArg]
          : [];

      // Parse --env KEY=VALUE flags
      const envList = Array.isArray(opts.env) ? opts.env : opts.env ? [opts.env] : [];
      const plainEnvVars: Record<string, string> = {};
      for (const entry of envList) {
        const eq = entry.indexOf('=');
        if (eq < 1) {
          console.error(`Error: --env value must be in KEY=VALUE format (got "${entry}").`);
          process.exit(1);
        }
        plainEnvVars[entry.slice(0, eq)] = entry.slice(eq + 1);
      }

      // Build tunnel config if all three params are provided
      let tunnel: TunnelConfig | undefined;
      if (opts.tunnelServer && opts.tunnelChannelId && opts.tunnelSecret) {
        tunnel = {
          serverUrl: opts.tunnelServer,
          channelId: opts.tunnelChannelId,
          secret: opts.tunnelSecret,
        };
      } else if (opts.tunnelServer || opts.tunnelChannelId || opts.tunnelSecret) {
        console.error('Error: --tunnel-server, --tunnel-channel-id, and --tunnel-secret must all be provided together.');
        process.exit(1);
      }

      // Auto-derive baseUrl from tunnel if not explicitly set
      const baseUrl = opts.baseUrl ?? (tunnel ? `${tunnel.serverUrl}/proxy/${tunnel.channelId}` : '');

      const project: Parameters<typeof addProject>[1] = {
        id,
        label: opts.label ?? id,
        engine,
        cwd: opts.cwd,
        port,
        host: opts.host,
        baseUrl,
        extraArgs,
        createdAt: new Date().toISOString(),
        tunnel,
        plainEnvVars: Object.keys(plainEnvVars).length > 0 ? plainEnvVars : undefined,
      };

      const next = addProject(cfg, project);
      ensureProjectDir(id);

      console.log(`Registered project "${id}".`);
      console.log(`  label:     ${project.label}`);
      console.log(`  engine:    ${project.engine}`);
      console.log(`  cwd:       ${project.cwd}`);
      console.log(`  bind:      ${project.host}:${project.port}`);
      if (project.baseUrl) console.log(`  base URL:  ${project.baseUrl}`);
      if (project.tunnel) {
        console.log(`  tunnel:    ${project.tunnel.serverUrl} / channel ${project.tunnel.channelId}`);
      }
      if (Object.keys(plainEnvVars).length > 0) {
        console.log(`  env vars:  ${Object.keys(plainEnvVars).join(', ')} (encrypted)`);
      }
      console.log('');
      console.log(`Next: shepaw-hub start ${id}`);
      void next;
    } catch (err) {
      exitWithError(err);
    }
  });

cli
  .command('project-list', 'List registered projects')
  .action(() => {
    const cfg = loadOrCreateHubConfig();
    if (cfg.projects.length === 0) {
      console.log('No projects registered.');
      console.log('  shepaw-hub project add <id> --engine codebuddy --cwd /path/to/code');
      return;
    }
    const rows = cfg.projects.map((p) => {
      const state = readState(projectPaths(p.id).statePath);
      const running = state !== undefined && state.pid > 0 && isAlive(state.pid);
      return {
        id: p.id,
        engine: p.engine,
        bind: `${p.host}:${p.port}`,
        status: running ? `running (pid ${state!.pid})` : 'stopped',
        label: p.label,
      };
    });
    const colW = {
      id: Math.max(2, ...rows.map((r) => r.id.length)),
      engine: Math.max(6, ...rows.map((r) => r.engine.length)),
      bind: Math.max(4, ...rows.map((r) => r.bind.length)),
      status: Math.max(6, ...rows.map((r) => r.status.length)),
    };
    console.log(
      `  ${'ID'.padEnd(colW.id)}  ${'ENGINE'.padEnd(colW.engine)}  ${'BIND'.padEnd(colW.bind)}  ${'STATUS'.padEnd(colW.status)}  LABEL`,
    );
    for (const r of rows) {
      console.log(
        `  ${r.id.padEnd(colW.id)}  ${r.engine.padEnd(colW.engine)}  ${r.bind.padEnd(colW.bind)}  ${r.status.padEnd(colW.status)}  ${r.label}`,
      );
    }
  });

cli
  .command('project-show <id>', 'Show detailed info for one project')
  .action((id: string) => {
    try {
      const cfg = loadOrCreateHubConfig();
      const p = getProject(cfg, id);
      const paths = projectPaths(id);
      const state = readState(paths.statePath);
      console.log(`Project: ${p.id}`);
      console.log(`  label:       ${p.label}`);
      console.log(`  engine:      ${p.engine}`);
      console.log(`  cwd:         ${p.cwd}`);
      console.log(`  bind:        ${p.host}:${p.port}`);
      console.log(`  base URL:    ${p.baseUrl || '(none — pair URL uses bind host)'}`);
      console.log(`  extra args:  ${p.extraArgs.length > 0 ? p.extraArgs.join(' ') : '(none)'}`);
      console.log(`  created at:  ${p.createdAt}`);
      if (p.tunnel) {
        console.log('');
        console.log('Tunnel:');
        console.log(`  server:      ${p.tunnel.serverUrl}`);
        console.log(`  channel ID:  ${p.tunnel.channelId}`);
        console.log(`  secret:      ${'*'.repeat(8)} (set)`);
      }
      console.log('');
      console.log('Files:');
      console.log(`  identity:      ${paths.identityPath}`);
      console.log(`  peers:         ${paths.peersPath}`);
      console.log(`  enrollments:   ${paths.enrollmentsPath}`);
      console.log(`  state:         ${paths.statePath}`);
      console.log(`  log:           ${paths.logFile}`);
      console.log('');
      if (state === undefined) {
        console.log('State:  (never started)');
      } else {
        const live = state.pid > 0 && isAlive(state.pid);
        console.log(`State:  ${live ? 'running' : 'stopped'}`);
        console.log(`  pid:         ${state.pid}`);
        console.log(`  started at:  ${state.startedAt}`);
        if (state.stoppedAt !== undefined) console.log(`  stopped at:  ${state.stoppedAt}`);
        if (state.lastResult !== undefined) console.log(`  last result: ${state.lastResult}`);
      }
    } catch (err) {
      exitWithError(err);
    }
  });

cli
  .command('project-remove <id>', 'Unregister a project (stops it first if running)')
  .option('--keep-files', 'Keep identity/peers/logs on disk (default: leave them be)')
  .action(async (id: string, _opts: { keepFiles?: boolean }) => {
    try {
      const cfg = loadOrCreateHubConfig();
      const p = getProject(cfg, id);
      const paths = projectPaths(id);

      const state = readState(paths.statePath);
      if (state !== undefined && state.pid > 0 && isAlive(state.pid)) {
        console.log(`Stopping running project "${id}" (pid ${state.pid})...`);
        const result = await stopProject(p);
        console.log(`  ${result}`);
      }

      const { removeProject } = await import('@shepaw/agent-hub-core');
      removeProject(cfg, id);
      console.log(`Unregistered project "${id}".`);
      console.log('  Files left on disk (delete manually if desired):');
      console.log(`    ${paths.root}`);
    } catch (err) {
      exitWithError(err);
    }
  });

cli
  .command('project-update <id>', 'Patch a project\'s non-critical fields')
  .option('--label <text>', 'New display name')
  .option('--host <host>', 'New bind host')
  .option('--base-url <url>', 'New base URL for pairing QRs')
  .option('--cwd <dir>', 'New working directory')
  .option('--extra-arg <arg>', 'Replace extra args (repeatable; pass to clear)')
  .option('--tunnel-server <url>', 'New Shepaw Channel Service base URL (update all three tunnel fields together)')
  .option('--tunnel-channel-id <id>', 'New channel ID')
  .option('--tunnel-secret <secret>', 'New channel HMAC-SHA256 signing secret')
  .option('--clear-tunnel', 'Remove tunnel configuration from this project')
  .option('--env <KEY=VALUE>', 'Set/update an env var, e.g. ANTHROPIC_API_KEY=sk-... (repeatable)', { default: [] })
  .option('--clear-env', 'Remove all stored env vars from this project')
  .action((id: string, opts: {
    label?: string;
    host?: string;
    baseUrl?: string;
    cwd?: string;
    extraArg?: string | string[];
    tunnelServer?: string;
    tunnelChannelId?: string;
    tunnelSecret?: string;
    clearTunnel?: boolean;
    env?: string | string[];
    clearEnv?: boolean;
  }) => {
    try {
      const cfg = loadOrCreateHubConfig();
      getProject(cfg, id);
      const patch: {
        label?: string;
        host?: string;
        baseUrl?: string;
        cwd?: string;
        extraArgs?: ReadonlyArray<string>;
        tunnel?: TunnelConfig;
        mergeEnvVars?: Record<string, string>;
        clearEnvVars?: boolean;
      } = {};
      if (opts.label !== undefined) patch.label = opts.label;
      if (opts.host !== undefined) patch.host = opts.host;
      if (opts.baseUrl !== undefined) patch.baseUrl = opts.baseUrl;
      if (opts.cwd !== undefined) patch.cwd = opts.cwd;
      if (opts.extraArg !== undefined) {
        patch.extraArgs = Array.isArray(opts.extraArg)
          ? opts.extraArg
          : [opts.extraArg];
      }
      if (opts.clearTunnel) {
        // Setting tunnel to undefined removes it from the config
        (patch as Record<string, unknown>).tunnel = undefined;
      } else if (opts.tunnelServer || opts.tunnelChannelId || opts.tunnelSecret) {
        if (!opts.tunnelServer || !opts.tunnelChannelId || !opts.tunnelSecret) {
          console.error('Error: --tunnel-server, --tunnel-channel-id, and --tunnel-secret must all be provided together.');
          process.exit(1);
        }
        patch.tunnel = {
          serverUrl: opts.tunnelServer,
          channelId: opts.tunnelChannelId,
          secret: opts.tunnelSecret,
        };
        // Auto-derive baseUrl from tunnel if --base-url wasn't explicitly set
        if (opts.baseUrl === undefined) {
          patch.baseUrl = `${opts.tunnelServer}/proxy/${opts.tunnelChannelId}`;
        }
      }
      if (Object.keys(patch).length === 0 && !opts.clearEnv && (Array.isArray(opts.env) ? opts.env.length === 0 : !opts.env)) {
        console.log('Nothing to update. Pass at least one of --label / --host / --base-url / --cwd / --extra-arg / --tunnel-* / --clear-tunnel / --env / --clear-env.');
        process.exit(1);
      }
      if (opts.clearEnv) patch.clearEnvVars = true;
      const envList = Array.isArray(opts.env) ? opts.env : opts.env ? [opts.env] : [];
      if (envList.length > 0) {
        const mergeEnvVars: Record<string, string> = {};
        for (const entry of envList) {
          const eq = entry.indexOf('=');
          if (eq < 1) {
            console.error(`Error: --env value must be in KEY=VALUE format (got "${entry}").`);
            process.exit(1);
          }
          mergeEnvVars[entry.slice(0, eq)] = entry.slice(eq + 1);
        }
        patch.mergeEnvVars = mergeEnvVars;
      }
      updateProject(cfg, id, patch);
      console.log(`Updated project "${id}".`);
      console.log('Restart for changes to take effect:  shepaw-hub stop ' + id + ' && shepaw-hub start ' + id);
    } catch (err) {
      exitWithError(err);
    }
  });

// ── lifecycle ──────────────────────────────────────────────────────

cli
  .command('start <id>', 'Start a project\'s gateway (detached)')
  .action(async (id: string) => {
    try {
      const cfg = loadOrCreateHubConfig();
      const p = getProject(cfg, id);
      ensureProjectDir(id);
      const result = await startProject(p);
      if (result.alreadyRunning) {
        console.log(`Project "${id}" was already running (pid ${result.pid}).`);
      } else {
        console.log(`Started "${id}" — pid ${result.pid}, bind ${p.host}:${p.port}.`);
        const paths = projectPaths(id);
        console.log(`  log: ${paths.logFile}`);
        console.log(`  pair: shepaw-hub pair ${id}`);
      }
    } catch (err) {
      exitWithError(err);
    }
  });

cli
  .command('stop <id>', 'Stop a project\'s gateway')
  .action(async (id: string) => {
    try {
      const cfg = loadOrCreateHubConfig();
      const p = getProject(cfg, id);
      const result = await stopProject(p);
      if (result === 'graceful') {
        console.log(`Stopped "${id}" gracefully.`);
      } else if (result === 'hard') {
        if (process.platform === 'win32') {
          console.log(
            `Terminated "${id}" (Windows has no graceful stop — agent did not ` +
              `flush in-flight sessions. Run 'shepaw-hub logs ${id}' to check last state).`,
          );
        } else {
          console.log(`Killed "${id}" (SIGTERM ignored; sent SIGKILL).`);
        }
      } else {
        console.log(`Project "${id}" was not running.`);
      }
    } catch (err) {
      exitWithError(err);
    }
  });

cli
  .command('status [id]', 'Show running state of one or all projects')
  .action((id: string | undefined) => {
    const cfg = loadOrCreateHubConfig();
    const projects = id !== undefined ? [getProject(cfg, id)] : [...cfg.projects];
    if (projects.length === 0) {
      console.log('No projects registered.');
      return;
    }
    for (const p of projects) {
      const paths = projectPaths(p.id);
      const state = readState(paths.statePath);
      const live = state !== undefined && state.pid > 0 && isAlive(state.pid);
      const liveTag = live ? 'running' : 'stopped';
      const pidTag = state?.pid !== undefined && state.pid > 0 ? ` pid=${state.pid}` : '';
      console.log(`${p.id}: ${liveTag}${pidTag}  bind=${p.host}:${p.port}  engine=${p.engine}`);
      if (state?.lastResult === 'crashed' && !live) {
        console.log(`  ⚠ last run ended unexpectedly — check ${paths.logFile}`);
      }
    }
  });

cli
  .command('logs <id>', 'Tail the gateway\'s stdout/stderr')
  .option('--tail <n>', 'Lines of existing log to print first', { default: 50 })
  .option('-f, --follow', 'Keep streaming new output')
  .action(async (id: string, opts: { tail?: number | string; follow?: boolean }) => {
    try {
      const cfg = loadOrCreateHubConfig();
      getProject(cfg, id);
      const ac = new AbortController();
      process.on('SIGINT', () => ac.abort());
      await tailLog(id, {
        tail: opts.tail !== undefined ? Number(opts.tail) : 50,
        follow: opts.follow === true,
        signal: ac.signal,
      });
    } catch (err) {
      exitWithError(err);
    }
  });

cli
  .command('logs-rotate <id>', 'Force log rotation for one project')
  .action(async (id: string) => {
    try {
      const cfg = loadOrCreateHubConfig();
      getProject(cfg, id);
      await rotateProjectLogs(id);
      console.log(`Rotated logs for "${id}".`);
    } catch (err) {
      exitWithError(err);
    }
  });

// ── enrollment / pair ──────────────────────────────────────────────

function runPair(
  id: string,
  opts: { label?: string; ttlMinutes?: number | string; qr?: boolean; baseUrl?: string },
): void {
  const cfg = loadOrCreateHubConfig();
  const project = getProject(cfg, id);
  const paths = projectPaths(id);
  ensureProjectDir(id);

  const identity = loadOrCreateIdentity({ path: paths.identityPath });
  const ttlMs = Math.max(1, Math.floor(Number(opts.ttlMinutes ?? 10))) * 60 * 1000;
  const token = createEnrollmentToken(paths.enrollmentsPath, {
    label: opts.label ?? 'hub-paired device',
    ttlMs,
  });
  const display = formatCodeForDisplay(token.code);
  const expires = new Date(token.expiresAt).toLocaleString();

  const base = opts.baseUrl ?? project.baseUrl;
  let pairUrl: string | undefined;
  if (base) {
    const clean = base.replace(/\/$/, '');
    pairUrl = `${clean}/acp/ws?agentId=${identity.agentId}#fp=${identity.fingerprint}`;
  } else {
    pairUrl = `ws://${project.host}:${project.port}/acp/ws?agentId=${identity.agentId}#fp=${identity.fingerprint}`;
  }

  const qrPayload = `shepaw://pair?url=${encodeURIComponent(pairUrl)}&code=${encodeURIComponent(token.code)}`;

  console.log('');
  console.log('╭──────────────────────────────────────────────╮');
  console.log(`│  Pairing code:  ${display.padEnd(28, ' ')} │`);
  console.log('╰──────────────────────────────────────────────╯');
  console.log('');
  console.log(`  Project:      ${project.id} (${project.label})`);
  console.log(`  Valid until:  ${expires}`);
  console.log(`  Single use:   the code is invalidated after first handshake.`);
  console.log(`  Agent ID:     ${identity.agentId}`);
  console.log(`  Fingerprint:  ${identity.fingerprint}`);
  console.log(`  Pair URL:     ${pairUrl}`);
  if (!base) {
    console.log(`  ⚠ No base URL configured — the URL above is loopback only.`);
    console.log(`     Set one with: shepaw-hub project update ${id} --base-url <url>`);
  }

  if (opts.qr !== false) {
    console.log('');
    console.log('  Scan with Shepaw app (or enter the code + URL manually):');
    console.log('');
    qrcode.generate(qrPayload, { small: true }, (qr: string) => {
      process.stdout.write(qr);
    });
  }
  console.log('');
}

cli
  .command('pair <id>', 'Mint a pairing code + QR for a project (shortcut for enroll)')
  .option('--label <text>', 'Label to record on the peer that redeems the code')
  .option('--ttl-minutes <n>', 'Override token TTL (default: 10)', { default: 10 })
  .option('--base-url <url>', 'Override the project\'s configured base URL for this pairing')
  .option('--no-qr', 'Suppress the terminal QR code')
  .action((id: string, opts: { label?: string; ttlMinutes?: number | string; baseUrl?: string; qr?: boolean }) => {
    try { runPair(id, opts); }
    catch (err) { exitWithError(err); }
  });

cli
  .command('enroll <id>', 'Alias for `pair <id>`')
  .option('--label <text>', 'Label to record on the peer that redeems the code')
  .option('--ttl-minutes <n>', 'Override token TTL (default: 10)', { default: 10 })
  .option('--base-url <url>', 'Override the project\'s configured base URL for this pairing')
  .option('--no-qr', 'Suppress the terminal QR code')
  .action((id: string, opts: { label?: string; ttlMinutes?: number | string; baseUrl?: string; qr?: boolean }) => {
    try { runPair(id, opts); }
    catch (err) { exitWithError(err); }
  });

cli
  .command('enroll-list <id>', 'Show outstanding pairing codes for a project')
  .action((id: string) => {
    try {
      const cfg = loadOrCreateHubConfig();
      getProject(cfg, id);
      const paths = projectPaths(id);
      const store = loadOrCreateEnrollments({ path: paths.enrollmentsPath });
      if (store.tokens.length === 0) {
        console.log(`No outstanding pairing codes for "${id}".`);
        console.log(`Mint one: shepaw-hub pair ${id}`);
        return;
      }
      console.log(`Outstanding pairing codes for "${id}" (${store.tokens.length}):`);
      console.log('');
      const rows = store.tokens.map((t) => ({
        code: formatCodeForDisplay(t.code),
        expires: new Date(t.expiresAt).toLocaleString(),
        label: t.label || '(unlabeled)',
      }));
      const codeW = Math.max(4, ...rows.map((r) => r.code.length));
      const expW = Math.max(7, ...rows.map((r) => r.expires.length));
      console.log(`  ${'CODE'.padEnd(codeW)}  ${'EXPIRES'.padEnd(expW)}  LABEL`);
      for (const r of rows) {
        console.log(`  ${r.code.padEnd(codeW)}  ${r.expires.padEnd(expW)}  ${r.label}`);
      }
    } catch (err) {
      exitWithError(err);
    }
  });

cli
  .command('enroll-revoke <id> <code>', 'Cancel an unused pairing code for a project')
  .action((id: string, code: string) => {
    try {
      const cfg = loadOrCreateHubConfig();
      getProject(cfg, id);
      const paths = projectPaths(id);
      const ok = revokeEnrollmentToken(paths.enrollmentsPath, code);
      if (ok) {
        console.log(`Revoked pairing code ${code} from project "${id}".`);
      } else {
        console.log(`No outstanding pairing code matching "${code}" for "${id}".`);
        process.exit(1);
      }
    } catch (err) {
      exitWithError(err);
    }
  });

// ── peers ──────────────────────────────────────────────────────────

cli
  .command('peers-list <id>', 'List authorized peer public keys for a project')
  .action((id: string) => {
    try {
      const cfg = loadOrCreateHubConfig();
      getProject(cfg, id);
      const paths = projectPaths(id);
      const peers = loadOrCreatePeers({ path: paths.peersPath });
      if (peers.peers.length === 0) {
        console.log(`No authorized peers for "${id}". File: ${paths.peersPath}`);
        console.log(`Add one: shepaw-hub peers add ${id} <pubkey> --label "my phone"`);
        console.log(`Or pair interactively: shepaw-hub pair ${id}`);
        return;
      }
      console.log(`Authorized peers for "${id}" (${peers.peers.length}):`);
      console.log('');
      const fpW = 'FINGERPRINT'.length;
      const addedW = Math.max(5, ...peers.peers.map((p) => p.addedAt.length));
      console.log(`  ${'FINGERPRINT'.padEnd(fpW)}  ${'ADDED'.padEnd(addedW)}  LABEL`);
      for (const p of peers.peers) {
        console.log(`  ${p.fingerprint.padEnd(fpW)}  ${p.addedAt.padEnd(addedW)}  ${p.label || '(unlabeled)'}`);
      }
    } catch (err) {
      exitWithError(err);
    }
  });

cli
  .command('peers-add <id> <pubkey>', 'Authorize a device on a specific project')
  .option('--label <text>', 'Device label')
  .action((id: string, pubkey: string, opts: { label?: string }) => {
    try {
      const cfg = loadOrCreateHubConfig();
      getProject(cfg, id);
      const paths = projectPaths(id);
      const entry = sdkAddPeer(paths.peersPath, pubkey, opts.label);
      console.log(`Authorized ${entry.fingerprint} (${entry.label || '(unlabeled)'}) for "${id}".`);
      console.log(`If the project is running, it will pick up the change within 100ms.`);
    } catch (err) {
      exitWithError(err);
    }
  });

cli
  .command('peers-remove <id> <fingerprint>', 'Revoke a device on a specific project')
  .action((id: string, fp: string) => {
    try {
      const cfg = loadOrCreateHubConfig();
      getProject(cfg, id);
      const paths = projectPaths(id);
      const removed = sdkRemovePeer(paths.peersPath, fp);
      if (removed) {
        console.log(`Revoked peer ${fp} from "${id}". Any live session closes within ~200ms.`);
      } else {
        console.log(`No peer with fingerprint ${fp} in "${id}".`);
        process.exit(1);
      }
    } catch (err) {
      exitWithError(err);
    }
  });

// ── web dashboard ──────────────────────────────────────────────────

cli
  .command('web', 'Start the web dashboard (API + UI) for managing projects')
  .option('--port <n>', 'Dashboard HTTP port (default: 4000)', { default: 4000 })
  .option('--host <host>', 'Dashboard bind host (default: 127.0.0.1)', { default: '127.0.0.1' })
  .option('--no-open', 'Do not automatically open the browser')
  .action(async (opts: { port: number | string; host: string; open?: boolean }) => {
    try {
      const port = Number(opts.port);
      const host = opts.host;
      const shouldOpen = opts.open !== false;

      console.log(`Starting Shepaw Hub dashboard on http://${host}:${port} ...`);

      const { startServer } = await import('@shepaw/agent-hub-api');
      await startServer({ port, host });

      const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
      console.log(`Dashboard ready: ${url}`);

      if (shouldOpen) {
        try {
          const { default: open } = await import('open');
          await open(url);
        } catch {
          // Silently ignore if `open` fails (headless env, etc.)
        }
      }
    } catch (err) {
      exitWithError(err);
    }
  });

// ── help formatting ────────────────────────────────────────────────

cli.help((sections) => {
  const restoreMap: Array<[RegExp, string]> = [
    [/project-(add|list|show|remove|update)/g, 'project $1'],
    [/peers-(list|add|remove)/g, 'peers $1'],
    [/logs-(rotate)/g, 'logs $1'],
    [/enroll-(list|revoke)/g, 'enroll $1'],
  ];
  for (const s of sections) {
    if (typeof s.body === 'string') {
      for (const [re, repl] of restoreMap) s.body = s.body.replace(re, repl);
    }
  }
  return sections;
});

cli.version('0.2.0');
cli.parse();

// ── helpers ────────────────────────────────────────────────────────

function parseEngine(raw: string): AgentEngine {
  if (
    raw === 'codebuddy'
    || raw === 'claude-code'
    || raw === 'tclaude'
    || raw === 'codex'
    || raw === 'tcodex'
    || raw === 'opencode'
    || raw === 'openclaw'
    || raw === 'cursor'
    || raw === 'hermes'
  ) {
    return raw;
  }
  throw new Error(
    `Invalid --engine: "${raw}". Expected codebuddy, claude-code, tclaude, codex, tcodex, opencode, openclaw, cursor, or hermes.`,
  );
}

function exitWithError(err: unknown): never {
  if (err instanceof ProjectNotFoundError || err instanceof ProjectExistsError) {
    console.error(err.message);
    process.exit(1);
  }
  if (err instanceof Error) {
    console.error(err.message);
    if (process.env.SHEPAW_HUB_DEBUG) console.error(err.stack);
    process.exit(1);
  }
  console.error(String(err));
  process.exit(1);
}

void findProject;
void nodeSpawn;
void existsSync;
void hubConfigPath;
