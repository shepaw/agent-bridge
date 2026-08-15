/**
 * CLI entry point: `shepaw-hub <subcommand> [options]`.
 *
 * Subcommand map:
 *
 *   init                           Initialize ~/.config/shepaw-hub/ (idempotent)
 *   doctor                         Pre-flight diagnostics (Node, engines, ports, instances)
 *   update                         Install the latest shepaw-agent-hub from npm
 *   quickstart                     Interactive: init → pick engine → start → print pairing QR
 *   test [id]                      Connectivity probe (HTTP; --rpc; --chat)
 *
 *   instance add                    Register a new instance (auto UUID)
 *   instance list                   List registered instances
 *   instance show <id>              Detailed info for one instance
 *   instance remove <id>            Unregister; stops first if running
 *   instance update <id>            Patch label / baseUrl / extraArgs / host / cwd
 *
 *   start <id>                     Spawn the gateway process (detached)
 *   stop <id>                      Stop the gateway (SIGTERM on Unix, TerminateProcess on Windows)
 *   status [<id>]                  Show running state (all instances if no id)
 *   logs <id>                      Tail the gateway's stdout/stderr
 *   logs rotate <id>               Force log rotation
 *
 *   pair                           Mint a shepaw://peer pairing QR (scan in the Shepaw app)
 *   peer pair                      Same as pair
 *   gateway pair [id]              Legacy ACP/gateway pairing QR (hub-wide or one instance)
 *   enroll <id>                    Alias for `gateway pair <id>`
 *   enroll-list <id>               List this instance's outstanding codes
 *   enroll-revoke <id> <code>      Cancel an unused code
 *
 *   peers list <id>                List authorized peers for a instance
 *   peers add <id> <pubkey>        Authorize a device
 *   peers remove <id> <fp>         Revoke a device
 *
 *   web [--port <n>]               Start the web dashboard (API + UI); also starts Peer
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
  addInstance,
  allocateInstanceId,
  addCustomEngineToHub,
  findInstance,
  getInstance,
  loadOrCreateHubConfig,
  listEngineInfos,
  InstanceExistsError,
  InstanceNotFoundError,
  removeCustomEngineFromHub,
  isKnownEngine,
  parseSessionMode,
  resolvePublicHost,
  type InstanceConfig,
  type TunnelConfig,
  CustomEngineExistsError,
  CustomEngineInUseError,
  CustomEngineNotFoundError,
} from '@shepaw/agent-hub-core';
import {
  ensureInstanceDir,
  isAlive,
  readState,
  rotateInstanceLogs,
  startInstance,
  stopInstance,
} from '@shepaw/agent-hub-core';
import { nextFreePort } from '@shepaw/agent-hub-core';
import { instancePaths, hubRoot, hubConfigPath, gatewayLogFile } from '@shepaw/agent-hub-core';
import { tailLog } from '@shepaw/agent-hub-core';
import { probeInstanceRuntime, createHubPairing } from '@shepaw/agent-hub-core';
import { updateInstance } from '@shepaw/agent-hub-core';
import { runDoctor } from './doctor.js';
import { readInstalledVersion, runUpdateCommand, notifyIfUpdateAvailable } from './self-update.js';
import { runQuickstart } from './quickstart.js';
import { runTest } from './test-cmd.js';
import {
  DEFAULT_ROUTER_PORT,
  setHubGateway,
  startGatewayRouter,
  stopGatewayRouter,
  readGatewayState,
  isGatewayRunning,
  startPeerService,
  stopPeerService,
  peerServiceStatus,
  mintPairingQr,
  loadPairedPeers,
  removePairedPeer,
  tryAuthorizePeerServiceOnInstance,
} from '@shepaw/agent-hub-core';

// ── multi-word dispatch ────────────────────────────────────────────
// 'project' is kept as a backward-compat alias for 'instance' (the concept
// was renamed); old `shepaw-hub project add ...` invocations still work.
const multiWord = new Set(['instance', 'project', 'peers', 'peer', 'logs', 'enroll', 'gateway']);
if (
  process.argv.length >= 4 &&
  typeof process.argv[2] === 'string' &&
  typeof process.argv[3] === 'string' &&
  multiWord.has(process.argv[2]) &&
  !process.argv[3].startsWith('-')
) {
  let outer = process.argv[2];
  if (outer === 'project') outer = 'instance';
  const inner = process.argv[3];
  process.argv.splice(2, 2, `${outer}-${inner}`);
}

const cli = cac('shepaw-hub');

// ── init ───────────────────────────────────────────────────────────

cli
  .command('doctor', 'Diagnose local setup (Node, engines, gateway package, instances)')
  .option('--full', 'Also probe engine versions and remote auth (slower)')
  .action(async (opts: { full?: boolean }) => {
    const failures = await runDoctor({ full: opts.full === true });
    if (failures > 0) process.exitCode = 1;
  });

cli
  .command('update', 'Install the latest shepaw-agent-hub from npm')
  .option('--check', 'Only report whether an update is available')
  .option('--yes', 'Install without prompting')
  .action(async (opts: { check?: boolean; yes?: boolean }) => {
    try {
      process.exitCode = await runUpdateCommand({
        check: opts.check === true,
        yes: opts.yes === true,
      });
    } catch (err) {
      exitWithError(err);
    }
  });

cli
  .command('test [id]', 'Probe instance connectivity (HTTP; optional Noise RPC / chat)')
  .option('--rpc', 'Also open a Noise WS and call agent.sessions.list')
  .option('--chat', 'Also send an agent.chat turn (implies --rpc; auto-approves tools)')
  .option('--message <text>', 'Override the --chat probe message')
  .option('--timeout-ms <n>', 'Chat timeout in milliseconds', { default: 60000 })
  .action(async (
    id: string | undefined,
    opts: { rpc?: boolean; chat?: boolean; message?: string; timeoutMs?: number | string },
  ) => {
    try {
      const failures = await runTest(id, {
        rpc: opts.rpc === true,
        chat: opts.chat === true,
        message: opts.message,
        timeoutMs: opts.timeoutMs !== undefined ? Number(opts.timeoutMs) : undefined,
      });
      if (failures > 0) process.exitCode = 1;
    } catch (err) {
      exitWithError(err);
    }
  });

cli
  .command('quickstart', 'Interactive onboarding: pick engine → start agent → start Peer → print pairing QR')
  .option('--engine <id>', 'Skip the engine picker')
  .option('--cwd <dir>', 'Working directory (default: current dir)')
  .option('--label <text>', 'Display label (default: directory basename)')
  .option('--host <host>', 'Bind host (default: 0.0.0.0 for LAN pairing)')
  .option('--yes', 'Non-interactive: accept defaults / require --engine')
  .option('--no-qr', 'Suppress the terminal QR code')
  .action(async (opts: {
    engine?: string;
    cwd?: string;
    label?: string;
    host?: string;
    yes?: boolean;
    qr?: boolean;
  }) => {
    try {
      await runQuickstart({
        engine: opts.engine,
        cwd: opts.cwd,
        label: opts.label,
        host: opts.host,
        yes: opts.yes === true,
        noQr: opts.qr === false,
      });
    } catch (err) {
      exitWithError(err);
    }
  });

cli
  .command('init', 'Create ~/.config/shepaw-hub/ and hub.json (idempotent)')
  .action(() => {
    const cfg = loadOrCreateHubConfig();
    console.log(`Hub config:   ${cfg.path}`);
    console.log(`Hub root:     ${hubRoot()}`);
    console.log(`Instances:     ${cfg.instances.length}`);
    if (cfg.instances.length === 0) {
      console.log('');
      console.log('Next: shepaw-hub web');
      console.log('  (opens the dashboard, starts Peer; add instances in the UI)');
    }
  });

// ── instance management ─────────────────────────────────────────────

cli
  .command('instance-add', 'Register a new agent instance (id is auto-generated UUID)')
  .option('--engine <engine>', 'Gateway engine id (built-in or custom; see shepaw-hub engine list)', { default: 'codebuddy' })
  .option('--cwd <dir>', 'Working directory for the gateway', { default: process.cwd() })
  .option('--label <text>', 'Display name shown in `status`')
  .option('--port <n>', 'Bind port (default: next free port from 8090)')
  .option('--host <host>', 'Bind host (default: 127.0.0.1; use 0.0.0.0 for LAN)', { default: '127.0.0.1' })
  .option('--base-url <url>', 'Base WS URL for pairing QRs (overrides tunnel-derived URL)')
  .option('--tunnel-server <url>', 'Shepaw Channel Service base URL')
  .option('--tunnel-channel-id <id>', 'Channel ID for this instance')
  .option('--tunnel-secret <secret>', 'HMAC-SHA256 signing secret for this channel')
  .option('--extra-arg <arg>', 'Extra argument passed through to gateway serve (repeatable)', { default: [] })
  .option('--env <KEY=VALUE>', 'Set a instance env var, e.g. ANTHROPIC_API_KEY=sk-... (repeatable)', { default: [] })
  .option('--session-mode <mode>', 'Native agent session mode (engine-specific, e.g. agent/plan/acceptEdits/on-request)')
  .action(async (opts: {
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
    sessionMode?: string;
  }) => {
    try {
      const cfg = loadOrCreateHubConfig();
      const id = allocateInstanceId(cfg.instances.map((p) => p.id));
      const engine = parseEngine(opts.engine, cfg);
      const reservedPorts = cfg.instances.map((p) => p.port);
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

      const resolvedMode = parseSessionMode(engine, opts.sessionMode);
      const instance: Parameters<typeof addInstance>[1] = {
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
        ...(resolvedMode !== undefined && { sessionMode: resolvedMode }),
        plainEnvVars: Object.keys(plainEnvVars).length > 0 ? plainEnvVars : undefined,
      };

      const next = addInstance(cfg, instance);
      ensureInstanceDir(id);
      tryAuthorizePeerServiceOnInstance(id);
      const saved = next.instances.find((p) => p.id === id);

      console.log(`Registered instance "${id}".`);
      console.log(`  label:     ${instance.label}`);
      console.log(`  engine:    ${instance.engine}`);
      if (saved?.sessionMode) console.log(`  mode:      ${saved.sessionMode}`);
      console.log(`  cwd:       ${instance.cwd}`);
      console.log(`  bind:      ${instance.host}:${instance.port}`);
      if (instance.baseUrl) console.log(`  base URL:  ${instance.baseUrl}`);
      if (instance.tunnel) {
        console.log(`  tunnel:    ${instance.tunnel.serverUrl} / channel ${instance.tunnel.channelId}`);
      }
      if (Object.keys(plainEnvVars).length > 0) {
        console.log(`  env vars:  ${Object.keys(plainEnvVars).join(', ')} (encrypted)`);
      }
      console.log('');
      console.log(`Next: shepaw-hub start ${id}`);
    } catch (err) {
      exitWithError(err);
    }
  });

cli
  .command('instance-list', 'List registered instances')
  .action(() => {
    const cfg = loadOrCreateHubConfig();
    if (cfg.instances.length === 0) {
      console.log('No instances registered.');
      console.log('  shepaw-hub instance add --engine codebuddy --cwd /path/to/code');
      return;
    }
    const rows = cfg.instances.map((p) => {
      const state = readState(instancePaths(p.id).statePath);
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
  .command('instance-show <id>', 'Show detailed info for one instance')
  .action((id: string) => {
    try {
      const cfg = loadOrCreateHubConfig();
      const p = getInstance(cfg, id);
      const paths = instancePaths(id);
      const state = readState(paths.statePath);
      console.log(`Instance: ${p.id}`);
      console.log(`  label:       ${p.label}`);
      console.log(`  engine:      ${p.engine}`);
      if (p.sessionMode) console.log(`  session mode: ${p.sessionMode}`);
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
  .command('instance-remove <id>', 'Unregister a instance (stops it first if running)')
  .option('--keep-files', 'Keep identity/peers/logs on disk (default: leave them be)')
  .action(async (id: string, _opts: { keepFiles?: boolean }) => {
    try {
      const cfg = loadOrCreateHubConfig();
      const p = getInstance(cfg, id);
      const paths = instancePaths(id);

      const state = readState(paths.statePath);
      if (state !== undefined && state.pid > 0 && isAlive(state.pid)) {
        console.log(`Stopping running instance "${id}" (pid ${state.pid})...`);
        const result = await stopInstance(p);
        console.log(`  ${result}`);
      }

      const { removeInstance } = await import('@shepaw/agent-hub-core');
      removeInstance(cfg, id);
      console.log(`Unregistered instance "${id}".`);
      console.log('  Files left on disk (delete manually if desired):');
      console.log(`    ${paths.root}`);
    } catch (err) {
      exitWithError(err);
    }
  });

cli
  .command('instance-update <id>', 'Patch a instance\'s non-critical fields')
  .option('--label <text>', 'New display name')
  .option('--host <host>', 'New bind host')
  .option('--base-url <url>', 'New base URL for pairing QRs')
  .option('--cwd <dir>', 'New working directory')
  .option('--extra-arg <arg>', 'Replace extra args (repeatable; pass to clear)')
  .option('--tunnel-server <url>', 'New Shepaw Channel Service base URL (update all three tunnel fields together)')
  .option('--tunnel-channel-id <id>', 'New channel ID')
  .option('--tunnel-secret <secret>', 'New channel HMAC-SHA256 signing secret')
  .option('--clear-tunnel', 'Remove tunnel configuration from this instance')
  .option('--env <KEY=VALUE>', 'Set/update an env var, e.g. ANTHROPIC_API_KEY=sk-... (repeatable)', { default: [] })
  .option('--clear-env', 'Remove all stored env vars from this instance')
  .option('--session-mode <mode>', 'Native agent session mode (engine-specific)')
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
    sessionMode?: string;
  }) => {
    try {
      const cfg = loadOrCreateHubConfig();
      getInstance(cfg, id);
      const patch: {
        label?: string;
        host?: string;
        baseUrl?: string;
        cwd?: string;
        extraArgs?: ReadonlyArray<string>;
        tunnel?: TunnelConfig;
        mergeEnvVars?: Record<string, string>;
        clearEnvVars?: boolean;
        sessionMode?: string;
      } = {};
      if (opts.label !== undefined) patch.label = opts.label;
      if (opts.host !== undefined) patch.host = opts.host;
      if (opts.baseUrl !== undefined) patch.baseUrl = opts.baseUrl;
      if (opts.cwd !== undefined) patch.cwd = opts.cwd;
      if (opts.sessionMode !== undefined) {
        const parsed = parseSessionMode(getInstance(cfg, id).engine, opts.sessionMode);
        if (parsed !== undefined) patch.sessionMode = parsed;
      }
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
      updateInstance(cfg, id, patch);
      console.log(`Updated instance "${id}".`);
      console.log('Restart for changes to take effect:  shepaw-hub stop ' + id + ' && shepaw-hub start ' + id);
    } catch (err) {
      exitWithError(err);
    }
  });

// ── lifecycle ──────────────────────────────────────────────────────

cli
  .command('start <id>', 'Start a instance\'s gateway (detached)')
  .action(async (id: string) => {
    try {
      const cfg = loadOrCreateHubConfig();
      const p = getInstance(cfg, id);
      ensureInstanceDir(id);
      tryAuthorizePeerServiceOnInstance(id);
      const result = await startInstance(p);
      if (result.alreadyRunning) {
        console.log(`Instance "${id}" was already running (pid ${result.pid}).`);
      } else {
        console.log(`Started "${id}" — pid ${result.pid}, bind ${p.host}:${p.port}.`);
        const paths = instancePaths(id);
        console.log(`  log: ${paths.logFile}`);
        console.log('  pair: shepaw-hub pair');
      }
    } catch (err) {
      exitWithError(err);
    }
  });

cli
  .command('stop <id>', 'Stop a instance\'s gateway')
  .action(async (id: string) => {
    try {
      const cfg = loadOrCreateHubConfig();
      const p = getInstance(cfg, id);
      const result = await stopInstance(p);
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
        console.log(`Instance "${id}" was not running.`);
      }
    } catch (err) {
      exitWithError(err);
    }
  });

cli
  .command('status [id]', 'Show running state of one or all instances')
  .action(async (id: string | undefined) => {
    const cfg = loadOrCreateHubConfig();
    const instances = id !== undefined ? [getInstance(cfg, id)] : [...cfg.instances];
    if (instances.length === 0) {
      console.log('No instances registered.');
      return;
    }
    for (const p of instances) {
      const st = await probeInstanceRuntime(p);
      const busyTag = st.busyLevel !== null ? `  busy=${st.busyLevel}` : '';
      const pidTag = st.pid !== null ? `  pid=${st.pid}` : '';
      console.log(`${p.id}: ${st.availability}${busyTag}${pidTag}  bind=${p.host}:${p.port}  engine=${p.engine}`);
      if (st.activeTasks !== null || st.connectedClients !== null) {
        console.log(
          `  tasks=${st.activeTasks ?? '?'}  clients=${st.connectedClients ?? '?'}  acp=${st.acpConnected ?? '?'}`,
        );
      }
      if (st.probeError) {
        console.log(`  probe: ${st.probeError}`);
      }
      if (st.lastResult === 'crashed' && !st.running) {
        console.log(`  last run ended unexpectedly — check ${instancePaths(p.id).logFile}`);
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
      getInstance(cfg, id);
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
  .command('logs-rotate <id>', 'Force log rotation for one instance')
  .action(async (id: string) => {
    try {
      const cfg = loadOrCreateHubConfig();
      getInstance(cfg, id);
      await rotateInstanceLogs(id);
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
  const instance = getInstance(cfg, id);
  const paths = instancePaths(id);
  ensureInstanceDir(id);

  const identity = loadOrCreateIdentity({ path: paths.identityPath });
  const ttlMs = Math.max(1, Math.floor(Number(opts.ttlMinutes ?? 10))) * 60 * 1000;
  const token = createEnrollmentToken(paths.enrollmentsPath, {
    label: opts.label ?? 'hub-paired device',
    ttlMs,
  });
  const display = formatCodeForDisplay(token.code);
  const expires = new Date(token.expiresAt).toLocaleString();

  const pkB64 = Buffer.from(identity.staticPublicKey).toString('base64');
  const pkEncoded = encodeURIComponent(pkB64);
  const fragmentParams = `fp=${identity.fingerprint}&pk=${pkEncoded}`;

  // Priority: explicit --base-url > shared gateway channel > legacy instance
  // baseUrl > loopback. The shared channel routes by /p/<instanceId>.
  const gatewayBase = gatewayChannelWsBase(cfg);
  let pairUrl: string;
  if (opts.baseUrl) {
    pairUrl = `${opts.baseUrl.replace(/\/$/, '')}/acp/ws?agentId=${identity.agentId}#${fragmentParams}`;
  } else if (gatewayBase) {
    pairUrl = `${gatewayBase}/p/${encodeURIComponent(instance.id)}/acp/ws?agentId=${identity.agentId}#${fragmentParams}`;
  } else if (instance.baseUrl) {
    pairUrl = `${instance.baseUrl.replace(/\/$/, '')}/acp/ws?agentId=${identity.agentId}#${fragmentParams}`;
  } else {
    const host = resolvePublicHost(instance.host);
    pairUrl = `ws://${host}:${instance.port}/acp/ws?agentId=${identity.agentId}#${fragmentParams}`;
  }

  const qrPayload = `shepaw://pair?url=${encodeURIComponent(pairUrl)}&code=${encodeURIComponent(token.code)}`;

  console.log('');
  console.log('╭──────────────────────────────────────────────╮');
  console.log(`│  Pairing code:  ${display.padEnd(28, ' ')} │`);
  console.log('╰──────────────────────────────────────────────╯');
  console.log('');
  console.log(`  Instance:      ${instance.id} (${instance.label})`);
  console.log(`  Valid until:  ${expires}`);
  console.log(`  Single use:   the code is invalidated after first handshake.`);
  console.log(`  Agent ID:     ${identity.agentId}`);
  console.log(`  Fingerprint:  ${identity.fingerprint}`);
  console.log(`  Pair URL:     ${pairUrl}`);
  if (!opts.baseUrl && !gatewayBase && !instance.baseUrl) {
    const publicHost = resolvePublicHost(instance.host);
    if (publicHost !== '127.0.0.1' && publicHost !== 'localhost') {
      console.log(`  LAN URL derived from bind host ${instance.host} → ${publicHost}.`);
      console.log(`  Phone must be on the same Wi-Fi; bind with --host 0.0.0.0 for LAN reachability.`);
    } else {
      console.log(`  ⚠ No shared channel or base URL configured — the URL above is loopback only.`);
      console.log(`     Configure the shared channel: shepaw-hub gateway set-channel ...`);
      console.log(`     Or a per-instance base URL: shepaw-hub instance update ${id} --base-url <url>`);
      console.log(`     Or re-register with --host 0.0.0.0 for same-Wi-Fi pairing.`);
    }
  }
  if (gatewayBase) warnRouterIfNeeded();

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

async function printPeerPairing(opts: { qr?: boolean } = {}): Promise<void> {
  const start = await startPeerService();
  if (start.relocated) {
    console.log(`Preferred peer port was busy; listening on ${start.host}:${start.port} instead.`);
    console.log('');
  }
  const res = await mintPairingQr();
  console.log('');
  console.log('╭──────────────────────────────────────────────╮');
  console.log(`│  Pairing code:  ${res.code.padEnd(28, ' ')} │`);
  console.log('╰──────────────────────────────────────────────╯');
  console.log('');
  console.log(`  Expires in:    ${Math.round((res.expiresAt - Date.now()) / 1000)}s`);
  console.log(`  Local:         ${res.localEndpoint}`);
  if (res.channelEndpoint) console.log(`  Channel:       ${res.channelEndpoint}`);
  console.log(`  Fingerprint:   ${res.fingerprint}`);
  console.log('');
  console.log('  Scan with the Shepaw app (Device Pairing / Scan to Connect).');
  console.log('  One scan authorizes every local agent on this machine.');
  console.log('');
  if (opts.qr !== false) {
    qrcode.generate(res.qrPayload, { small: true }, (qr: string) => {
      process.stdout.write(qr);
    });
    console.log('');
  }
}

function runHubPair(
  opts: { label?: string; ttlMinutes?: number | string; qr?: boolean; baseUrl?: string },
): void {
  const ttlMs = Math.max(1, Math.floor(Number(opts.ttlMinutes ?? 10))) * 60 * 1000;
  const result = createHubPairing({
    label: opts.label ?? 'Shepaw device',
    ttlMs,
    baseUrl: opts.baseUrl,
  });

  console.log('');
  console.log('╭──────────────────────────────────────────────╮');
  console.log(`│  Hub pairing code:  ${result.display.padEnd(23, ' ')} │`);
  console.log('╰──────────────────────────────────────────────╯');
  console.log('');
  console.log(`  Bootstrap agent: ${result.bootstrapInstanceId}`);
  console.log(`  Valid until:     ${new Date(result.expiresAt).toLocaleString()}`);
  console.log(`  Agents:          ${result.agents.length} (all authorized after one scan)`);
  console.log(`  Pair URL:        ${result.pairUrl}`);
  console.log('');
  console.log('  After pairing in the Shepaw app, add other agents using their WS URLs');
  console.log('  (no pairing code needed — device is already authorized).');
  console.log('');
  warnRouterIfNeeded();

  if (opts.qr !== false) {
    console.log('  Scan with Shepaw app:');
    console.log('');
    qrcode.generate(result.qrPayload, { small: true }, (qr: string) => {
      process.stdout.write(qr);
    });
  }
  console.log('');
}

cli
  .command('pair [id]', 'Mint a shepaw://peer pairing QR (scan in the Shepaw app)')
  .option('--label <text>', 'Unused placeholder (kept for symmetry)')
  .option('--no-qr', 'Suppress the terminal QR code')
  .action(async (id: string | undefined, opts: { qr?: boolean }) => {
    try {
      if (id !== undefined) {
        console.log('Note: `shepaw-hub pair` uses the peer channel and authorizes every agent on this machine.');
        console.log(`      For a per-agent ACP/gateway QR, use: shepaw-hub gateway pair ${id}`);
        console.log('');
      }
      await printPeerPairing({ qr: opts.qr !== false });
    } catch (err) { exitWithError(err); }
  });

cli
  .command('gateway-pair [id]', 'Mint ACP/gateway pairing QR (legacy; prefer `shepaw-hub pair`)')
  .option('--label <text>', 'Label to record on the peer that redeems the code')
  .option('--ttl-minutes <n>', 'Override token TTL (default: 10)', { default: 10 })
  .option('--base-url <url>', 'Override public WS base URL for the QR')
  .option('--no-qr', 'Suppress the terminal QR code')
  .action((id: string | undefined, opts: { label?: string; ttlMinutes?: number | string; baseUrl?: string; qr?: boolean }) => {
    try {
      if (id === undefined) {
        runHubPair(opts);
      } else {
        runPair(id, opts);
      }
    } catch (err) { exitWithError(err); }
  });

cli
  .command('pair-instance <id>', 'Mint a pairing code + QR for one instance only (alias: gateway pair)')
  .option('--label <text>', 'Label to record on the peer that redeems the code')
  .option('--ttl-minutes <n>', 'Override token TTL (default: 10)', { default: 10 })
  .option('--base-url <url>', 'Override the instance\'s configured base URL for this pairing')
  .option('--no-qr', 'Suppress the terminal QR code')
  .action((id: string, opts: { label?: string; ttlMinutes?: number | string; baseUrl?: string; qr?: boolean }) => {
    try {
      console.log('Note: prefer `shepaw-hub pair` (peer channel) or `shepaw-hub gateway pair <id>`.');
      console.log('');
      runPair(id, opts);
    }
    catch (err) { exitWithError(err); }
  });

cli
  .command('enroll <id>', 'Alias for `gateway pair <id>`')
  .option('--label <text>', 'Label to record on the peer that redeems the code')
  .option('--ttl-minutes <n>', 'Override token TTL (default: 10)', { default: 10 })
  .option('--base-url <url>', 'Override the instance\'s configured base URL for this pairing')
  .option('--no-qr', 'Suppress the terminal QR code')
  .action((id: string, opts: { label?: string; ttlMinutes?: number | string; baseUrl?: string; qr?: boolean }) => {
    try {
      console.log('Note: prefer `shepaw-hub pair` (peer channel). This command is `gateway pair`.');
      console.log('');
      runPair(id, opts);
    }
    catch (err) { exitWithError(err); }
  });

cli
  .command('enroll-list <id>', 'Show outstanding pairing codes for a instance')
  .action((id: string) => {
    try {
      const cfg = loadOrCreateHubConfig();
      getInstance(cfg, id);
      const paths = instancePaths(id);
      const store = loadOrCreateEnrollments({ path: paths.enrollmentsPath });
      if (store.tokens.length === 0) {
        console.log(`No outstanding pairing codes for "${id}".`);
        console.log(`Mint one: shepaw-hub gateway pair ${id}`);
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
  .command('enroll-revoke <id> <code>', 'Cancel an unused pairing code for a instance')
  .action((id: string, code: string) => {
    try {
      const cfg = loadOrCreateHubConfig();
      getInstance(cfg, id);
      const paths = instancePaths(id);
      const ok = revokeEnrollmentToken(paths.enrollmentsPath, code);
      if (ok) {
        console.log(`Revoked pairing code ${code} from instance "${id}".`);
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
  .command('peers-list <id>', 'List authorized peer public keys for a instance')
  .action((id: string) => {
    try {
      const cfg = loadOrCreateHubConfig();
      getInstance(cfg, id);
      const paths = instancePaths(id);
      const peers = loadOrCreatePeers({ path: paths.peersPath });
      if (peers.peers.length === 0) {
        console.log(`No authorized peers for "${id}". File: ${paths.peersPath}`);
        console.log(`Add one: shepaw-hub peers add ${id} <pubkey> --label "my phone"`);
        console.log('Or pair via Peer: shepaw-hub pair');
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
  .command('peers-add <id> <pubkey>', 'Authorize a device on a specific instance')
  .option('--label <text>', 'Device label')
  .action((id: string, pubkey: string, opts: { label?: string }) => {
    try {
      const cfg = loadOrCreateHubConfig();
      getInstance(cfg, id);
      const paths = instancePaths(id);
      const entry = sdkAddPeer(paths.peersPath, pubkey, opts.label);
      console.log(`Authorized ${entry.fingerprint} (${entry.label || '(unlabeled)'}) for "${id}".`);
      console.log(`If the instance is running, it will pick up the change within 100ms.`);
    } catch (err) {
      exitWithError(err);
    }
  });

cli
  .command('peers-remove <id> <fingerprint>', 'Revoke a device on a specific instance')
  .action((id: string, fp: string) => {
    try {
      const cfg = loadOrCreateHubConfig();
      getInstance(cfg, id);
      const paths = instancePaths(id);
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

// ── custom engines ────────────────────────────────────────────────

cli
  .command('engine list', 'List built-in and custom ACP engines')
  .action(() => {
    try {
      const cfg = loadOrCreateHubConfig();
      const engines = listEngineInfos(cfg.customEngines);
      console.log('  ID              DISPLAY NAME           TYPE       ACP COMMAND');
      for (const e of engines) {
        const cmd = e.acpCommand.length > 40 ? `${e.acpCommand.slice(0, 37)}...` : e.acpCommand;
        console.log(
          `  ${e.id.padEnd(16)}${e.displayName.padEnd(23)}${(e.builtin ? 'built-in' : 'custom').padEnd(11)}${cmd || '—'}`,
        );
      }
    } catch (err) {
      exitWithError(err);
    }
  });

cli
  .command('engine add <id>', 'Register a custom local ACP CLI')
  .option('--display <name>', 'Human-readable name shown in Hub UI')
  .option('--command <cmd>', 'Upstream ACP spawn command, e.g. "my-agent acp"')
  .action((id: string, opts: { display?: string; command?: string }) => {
    try {
      if (!opts.command || opts.command.trim().length === 0) {
        console.error('Error: --command is required.');
        process.exit(1);
      }
      const cfg = loadOrCreateHubConfig();
      addCustomEngineToHub(cfg, {
        id,
        displayName: opts.display ?? id,
        acpCommand: opts.command,
      });
      console.log(`Registered custom engine "${id}".`);
    } catch (err) {
      exitWithError(err);
    }
  });

cli
  .command('engine remove <id>', 'Remove a custom engine definition')
  .action((id: string) => {
    try {
      const cfg = loadOrCreateHubConfig();
      removeCustomEngineFromHub(cfg, id);
      console.log(`Removed custom engine "${id}".`);
    } catch (err) {
      exitWithError(err);
    }
  });

// ── gateway (shared channel + tunnel router) ───────────────────────

cli
  .command('gateway-set-channel', 'Configure the shared Channel Service tunnel for the whole device')
  .option('--server <url>', 'Shepaw Channel Service base URL')
  .option('--channel-id <id>', 'Channel ID')
  .option('--secret <secret>', 'HMAC-SHA256 signing secret for the channel')
  .option('--router-port <n>', `Local dispatch port (default: ${DEFAULT_ROUTER_PORT})`)
  .action((opts: { server?: string; channelId?: string; secret?: string; routerPort?: number | string }) => {
    try {
      if (!opts.server || !opts.channelId || !opts.secret) {
        console.error('Error: --server, --channel-id, and --secret are all required.');
        process.exit(1);
      }
      const cfg = loadOrCreateHubConfig();
      setHubGateway(cfg, {
        tunnel: { serverUrl: opts.server, channelId: opts.channelId, secret: opts.secret },
        routerPort: opts.routerPort !== undefined ? Number(opts.routerPort) : undefined,
      });
      console.log('Configured shared gateway channel.');
      console.log(`  server:      ${opts.server}`);
      console.log(`  channel ID:  ${opts.channelId}`);
      console.log(`  secret:      ${'*'.repeat(8)} (set)`);
      console.log('');
      console.log('Start the tunnel router:  shepaw-hub gateway start');
      if (isGatewayRunning()) {
        console.log('(router already running — restart to apply: shepaw-hub gateway stop && shepaw-hub gateway start)');
      }
    } catch (err) {
      exitWithError(err);
    }
  });

cli
  .command('gateway-clear-channel', 'Remove the shared channel tunnel (LAN-only)')
  .action(() => {
    try {
      const cfg = loadOrCreateHubConfig();
      setHubGateway(cfg, { tunnel: null });
      console.log('Cleared shared gateway channel. Restart the router if running.');
    } catch (err) {
      exitWithError(err);
    }
  });

cli
  .command('gateway-show', 'Show the gateway channel + router configuration')
  .action(() => {
    try {
      const cfg = loadOrCreateHubConfig();
      const gw = cfg.gateway;
      const state = readGatewayState();
      const running = state !== undefined && state.pid > 0 && isAlive(state.pid);
      console.log('Gateway:');
      console.log(`  router port: ${gw?.routerPort ?? DEFAULT_ROUTER_PORT}`);
      console.log(`  router host: ${gw?.routerHost ?? '127.0.0.1'}`);
      if (gw?.tunnel) {
        console.log('');
        console.log('Shared channel:');
        console.log(`  server:      ${gw.tunnel.serverUrl}`);
        console.log(`  channel ID:  ${gw.tunnel.channelId}`);
        console.log(`  secret:      ${'*'.repeat(8)} (set)`);
      } else {
        console.log('  channel:     (none — LAN-only)');
      }
      console.log('');
      console.log(`Router:  ${running ? `running (pid ${state!.pid})` : 'stopped'}`);
      console.log(`  log:   ${gatewayLogFile()}`);
    } catch (err) {
      exitWithError(err);
    }
  });

cli
  .command('gateway-start', 'Start the device tunnel router (detached)')
  .action(async () => {
    try {
      const cfg = loadOrCreateHubConfig();
      const result = await startGatewayRouter(cfg);
      if (result.alreadyRunning) {
        console.log(`Tunnel router already running (pid ${result.pid}, port ${result.routerPort}).`);
      } else {
        console.log(`Started tunnel router — pid ${result.pid}, dispatch port ${result.routerPort}.`);
        console.log(`  log: ${gatewayLogFile()}`);
        if (cfg.gateway?.tunnel === undefined) {
          console.log('  ⚠ No shared channel configured — router is LAN-only.');
          console.log('     Configure one: shepaw-hub gateway set-channel --server <url> --channel-id <id> --secret <secret>');
        }
      }
    } catch (err) {
      exitWithError(err);
    }
  });

cli
  .command('gateway-stop', 'Stop the device tunnel router')
  .action(async () => {
    try {
      const result = await stopGatewayRouter();
      if (result === 'graceful') console.log('Stopped tunnel router gracefully.');
      else if (result === 'hard') console.log('Killed tunnel router (SIGTERM ignored; sent SIGKILL).');
      else console.log('Tunnel router was not running.');
    } catch (err) {
      exitWithError(err);
    }
  });

cli
  .command('gateway-status', 'Show tunnel router running state')
  .action(() => {
    try {
      const state = readGatewayState();
      if (state === undefined) {
        console.log('Tunnel router: never started.');
        return;
      }
      const running = state.pid > 0 && isAlive(state.pid);
      console.log(`Tunnel router: ${running ? 'running' : 'stopped'}`);
      if (running) console.log(`  pid:         ${state.pid}`);
      console.log(`  router port: ${state.routerPort}`);
      console.log(`  started at:  ${state.startedAt}`);
      if (state.stoppedAt !== undefined) console.log(`  stopped at:  ${state.stoppedAt}`);
      if (state.lastResult !== undefined) console.log(`  last result: ${state.lastResult}`);
    } catch (err) {
      exitWithError(err);
    }
  });

// ── peer service (shepaw://peer) ───────────────────────────────────

cli
  .command('peer-start', 'Start the device peer service (shepaw://peer responder)')
  .action(async () => {
    try {
      const res = await startPeerService();
      console.log(`Peer service ${res.alreadyRunning ? 'already running' : 'started'} — pid ${res.pid}, bind ${res.host}:${res.port}/peer/ws`);
      if (res.relocated) {
        console.log('Preferred peer port was busy; using the bind above.');
      }
    } catch (err) {
      exitWithError(err);
    }
  });

cli
  .command('peer-stop', 'Stop the device peer service')
  .action(async () => {
    try {
      const res = await stopPeerService();
      console.log(`Peer service: ${res}`);
    } catch (err) {
      exitWithError(err);
    }
  });

cli
  .command('peer-status', 'Show peer service running state + paired devices')
  .action(() => {
    try {
      const st = peerServiceStatus();
      console.log(`Peer service: ${st.running ? 'running' : 'stopped'}`);
      if (st.running) console.log(`  pid:        ${st.pid}`);
      console.log(`  bind:       ${st.host}:${st.port}/peer/ws`);
      if (st.startedAt) console.log(`  started at: ${st.startedAt}`);
      const devices = loadPairedPeers();
      console.log(`  paired:     ${devices.length} device(s)`);
      for (const d of devices) {
        console.log(`    ${d.fingerprint}  ${d.deviceName}  (paired ${d.pairedAt})`);
      }
    } catch (err) {
      exitWithError(err);
    }
  });

cli
  .command('peer-pair', 'Mint a shepaw://peer pairing code + QR (same as `shepaw-hub pair`)')
  .option('--label <label>', 'Unused placeholder (kept for symmetry with pair)')
  .option('--no-qr', 'Suppress the terminal QR code')
  .action(async (opts: { qr?: boolean }) => {
    try {
      await printPeerPairing({ qr: opts.qr !== false });
    } catch (err) {
      exitWithError(err);
    }
  });

cli
  .command('peer-devices', 'List devices paired with the peer service')
  .action(() => {
    try {
      const devices = loadPairedPeers();
      if (devices.length === 0) {
        console.log('No paired devices.');
        return;
      }
      for (const d of devices) {
        console.log(`${d.fingerprint}  ${d.deviceName}  ${d.deviceId}  (paired ${d.pairedAt})`);
      }
    } catch (err) {
      exitWithError(err);
    }
  });

cli
  .command('peer-devices-remove <fingerprint>', 'Revoke a paired device')
  .action((fingerprint: string) => {
    try {
      const remaining = removePairedPeer(fingerprint);
      console.log(`Removed. ${remaining.length} device(s) still paired.`);
    } catch (err) {
      exitWithError(err);
    }
  });

// ── web dashboard ──────────────────────────────────────────────────

cli
  .command('web', 'Start the web dashboard (API + UI); auto-starts Peer so the app can pair')
  .option('--port <n>', 'Dashboard HTTP port (default: 4000)', { default: 4000 })
  .option('--host <host>', 'Dashboard bind host (default: 127.0.0.1)', { default: '127.0.0.1' })
  .option('--tls-cert <path>', 'PEM certificate for HTTPS (or SHEPAW_HUB_TLS_CERT)')
  .option('--tls-key <path>', 'PEM private key for HTTPS (or SHEPAW_HUB_TLS_KEY)')
  .option('--no-open', 'Do not automatically open the browser')
  .option('--no-peer', 'Do not auto-start the device peer service')
  .option('--gateway', 'Also start the tunnel router if a channel is configured')
  .action(async (opts: {
    port: number | string;
    host: string;
    tlsCert?: string;
    tlsKey?: string;
    open?: boolean;
    peer?: boolean;
    gateway?: boolean;
  }) => {
    try {
      const port = Number(opts.port);
      const host = opts.host;
      const shouldOpen = opts.open !== false;
      const authToken = process.env.SHEPAW_HUB_TOKEN?.trim();
      const tlsCert = opts.tlsCert ?? process.env.SHEPAW_HUB_TLS_CERT?.trim();
      const tlsKey = opts.tlsKey ?? process.env.SHEPAW_HUB_TLS_KEY?.trim();
      const tlsEnabled = Boolean(tlsCert || tlsKey);
      const scheme = tlsEnabled ? 'https' : 'http';

      if (host === '0.0.0.0' || host === '::') {
        console.warn('');
        console.warn('WARNING: Binding the Hub dashboard to all interfaces.');
        console.warn('  This exposes start/stop/engine APIs on your LAN/public network.');
        console.warn('  SHEPAW_HUB_TOKEN is REQUIRED for non-loopback binds.');
        console.warn('  Prefer: shepaw-hub web --host 127.0.0.1');
        console.warn('');
        if (!authToken) {
          console.error('Refusing to start: set SHEPAW_HUB_TOKEN before using --host 0.0.0.0');
          process.exit(1);
        }
      }

      console.log(`Starting Shepaw Hub dashboard on ${scheme}://${host}:${port} ...`);
      if (tlsEnabled) {
        console.log(`TLS: cert=${tlsCert ?? '(env)'} key=${tlsKey ?? '(env)'}`);
      }
      if (authToken) {
        console.log('Auth: SHEPAW_HUB_TOKEN is set (Bearer required for /api and /ws).');
      }

      const { startServer } = await import('@shepaw/agent-hub-api');
      await startServer({ port, host, authToken, tlsCert, tlsKey });

      const baseUrl = `${scheme}://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
      console.log(`Dashboard ready: ${baseUrl}`);
      if (authToken) {
        console.log('  Auth enabled: open the URL and enter SHEPAW_HUB_TOKEN in the login dialog.');
        console.log('  (Token is not passed via URL — paste it in the dashboard when prompted.)');
      }

      if (opts.peer !== false) {
        try {
          const res = await startPeerService();
          console.log(
            `Peer service: ${res.alreadyRunning ? 'already running' : 'started'} ` +
              `on ${res.host}:${res.port}/peer/ws (pid ${res.pid})`,
          );
          if (res.relocated) {
            console.log('  Preferred peer port was busy; using the bind above.');
          }
          console.log('  Next: open the dashboard → 添加实例. Pair phones under 扫码配对.');
        } catch (err) {
          console.warn(
            `Peer service failed to start: ${err instanceof Error ? err.message : String(err)}`,
          );
          console.warn('  App pairing will not work until you run: shepaw-hub peer-start');
        }
      } else {
        console.log('Peer service: skipped (--no-peer). Start later with: shepaw-hub peer-start');
      }

      if (opts.gateway) {
        const cfg = loadOrCreateHubConfig();
        if (cfg.gateway?.tunnel !== undefined) {
          try {
            const res = await startGatewayRouter(cfg);
            console.log(
              `Tunnel router: ${res.alreadyRunning ? 'already running' : 'started'} ` +
                `(pid ${res.pid}, port ${res.routerPort})`,
            );
          } catch (err) {
            console.warn(
              `Tunnel router failed to start: ${err instanceof Error ? err.message : String(err)}`,
            );
            console.warn('  Remote pairing will not work until you run: shepaw-hub gateway-start');
          }
        }
      }

      if (shouldOpen) {
        try {
          const { default: open } = await import('open');
          await open(baseUrl);
        } catch {
          // Silently ignore if `open` fails (headless env, etc.)
        }
      }

      void notifyIfUpdateAvailable();
    } catch (err) {
      exitWithError(err);
    }
  });

// ── help formatting ────────────────────────────────────────────────

cli.help((sections) => {
  const restoreMap: Array<[RegExp, string]> = [
    [/instance-(add|list|show|remove|update)/g, 'instance $1'],
    [/peers-(list|add|remove)/g, 'peers $1'],
    [/logs-(rotate)/g, 'logs $1'],
    [/enroll-(list|revoke)/g, 'enroll $1'],
    [/gateway-(pair|set-channel|clear-channel|show|start|stop|status)/g, 'gateway $1'],
    [/peer-(start|stop|status|pair|devices|devices-remove)/g, 'peer $1'],
  ];
  for (const s of sections) {
    if (typeof s.body === 'string') {
      for (const [re, repl] of restoreMap) s.body = s.body.replace(re, repl);
    }
  }
  return sections;
});

cli.version(readInstalledVersion());
cli.parse();

// ── helpers ────────────────────────────────────────────────────────

/**
 * When a shared channel is configured, remote pairing only works if the
 * tunnel router is running. Warn (with the fix) so a freshly-minted QR isn't
 * silently unreachable.
 */
function warnRouterIfNeeded(): void {
  const cfg = loadOrCreateHubConfig();
  if (cfg.gateway?.tunnel === undefined) return;
  if (isGatewayRunning()) return;
  console.log('  ⚠ Shared channel is configured but the tunnel router is NOT running.');
  console.log('     Remote pairing/connections will fail until you start it:');
  console.log('       shepaw-hub gateway start');
  console.log('');
}

/** `wss://<server>/proxy/<channelId>` base for the shared gateway channel. */
function gatewayChannelWsBase(cfg: ReturnType<typeof loadOrCreateHubConfig>): string | undefined {
  const t = cfg.gateway?.tunnel;
  if (t === undefined) return undefined;
  const wsBase = t.serverUrl
    .replace(/\/+$/, '')
    .replace(/^https:\/\//, 'wss://')
    .replace(/^http:\/\//, 'ws://');
  return `${wsBase}/proxy/${t.channelId}`;
}

function parseEngine(raw: string, cfg: ReturnType<typeof loadOrCreateHubConfig>): string {
  if (!isKnownEngine(raw, cfg.customEngines)) {
    throw new Error(
      `Invalid --engine: "${raw}". Run 'shepaw-hub engine list' for built-in and custom engines.`,
    );
  }
  return raw;
}

function exitWithError(err: unknown): never {
  if (
    err instanceof InstanceNotFoundError
    || err instanceof InstanceExistsError
    || err instanceof CustomEngineExistsError
    || err instanceof CustomEngineNotFoundError
    || err instanceof CustomEngineInUseError
  ) {
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

void findInstance;
void nodeSpawn;
void existsSync;
void hubConfigPath;
