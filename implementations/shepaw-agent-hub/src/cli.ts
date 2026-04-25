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
 *                                  Handy shortcut for the most common flow.
 *   enroll <id>                    Same as pair; preserved for consistency with gateway CLIs.
 *   enroll-list <id>               List this project's outstanding codes
 *   enroll-revoke <id> <code>      Cancel an unused code
 *
 *   peers list <id>                List authorized peers for a project
 *   peers add <id> <pubkey>        Authorize a device
 *   peers remove <id> <fp>         Revoke a device
 *
 * Multi-word subcommand dispatch (`project add`, `peers list`, `logs rotate`,
 * `enroll list`, `enroll revoke`) uses the same argv-rewrite trick as the
 * gateway CLIs. cac's parser treats only the first word as a command;
 * rewriting `<first> <second>` → `<first>-<second>` makes cac happy
 * without the user ever seeing the hyphen.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';

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
  removeProject,
  updateProject,
  type AgentEngine,
  type ProjectConfig,
} from './config.js';
import {
  ensureProjectDir,
  isAlive,
  readState,
  rotateProjectLogs,
  startProject,
  stopProject,
} from './spawn.js';
import { nextFreePort } from './ports.js';
import { projectPaths, hubRoot, hubConfigPath } from './paths.js';
import { tailLog } from './logs.js';

// ── multi-word dispatch ────────────────────────────────────────────
//
// Rewrite `shepaw-hub <outer> <inner> [...rest]` into
// `shepaw-hub <outer>-<inner> [...rest]` BEFORE cac reads process.argv.
// Must mutate in place — see gateway CLIs for the longer note on why.
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
  .option('--engine <engine>', 'Gateway engine: codebuddy | claude-code', { default: 'codebuddy' })
  .option('--cwd <dir>', 'Working directory for the gateway', { default: process.cwd() })
  .option('--label <text>', 'Display name shown in `status`')
  .option('--port <n>', 'Bind port (default: next free port from 8090)')
  .option('--host <host>', 'Bind host (default: 127.0.0.1; use 0.0.0.0 for LAN)', { default: '127.0.0.1' })
  .option('--base-url <url>', 'Base WS URL for pairing QRs (tunnel endpoint, typically)')
  .option('--extra-arg <arg>', 'Extra argument passed through to gateway serve (repeatable)', { default: [] })
  .action(async (id: string, opts: {
    engine: string;
    cwd: string;
    label?: string;
    port?: number | string;
    host: string;
    baseUrl?: string;
    extraArg?: string | string[];
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

      const project: ProjectConfig = {
        id,
        label: opts.label ?? id,
        engine,
        cwd: opts.cwd,
        port,
        host: opts.host,
        baseUrl: opts.baseUrl ?? '',
        extraArgs,
        createdAt: new Date().toISOString(),
      };

      const next = addProject(cfg, project);
      ensureProjectDir(id);

      console.log(`Registered project "${id}".`);
      console.log(`  label:     ${project.label}`);
      console.log(`  engine:    ${project.engine}`);
      console.log(`  cwd:       ${project.cwd}`);
      console.log(`  bind:      ${project.host}:${project.port}`);
      if (project.baseUrl) console.log(`  base URL:  ${project.baseUrl}`);
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

      // Stop first if running. Don't surface "not-running" as an error; it's
      // the expected path for projects that haven't been touched in a while.
      const state = readState(paths.statePath);
      if (state !== undefined && state.pid > 0 && isAlive(state.pid)) {
        console.log(`Stopping running project "${id}" (pid ${state.pid})...`);
        const result = await stopProject(p);
        console.log(`  ${result}`);
      }

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
  .action((id: string, opts: {
    label?: string;
    host?: string;
    baseUrl?: string;
    cwd?: string;
    extraArg?: string | string[];
  }) => {
    try {
      const cfg = loadOrCreateHubConfig();
      getProject(cfg, id); // existence check
      // Build a mutable patch object; updateProject's signature accepts
      // Readonly<Partial<...>> but we need to assign fields conditionally.
      const patch: {
        label?: string;
        host?: string;
        baseUrl?: string;
        cwd?: string;
        extraArgs?: ReadonlyArray<string>;
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
      if (Object.keys(patch).length === 0) {
        console.log('Nothing to update. Pass at least one of --label / --host / --base-url / --cwd / --extra-arg.');
        process.exit(1);
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
      // Stop following on Ctrl-C; node prints "\n" before exit so the log
      // reader sees a clean final line.
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

/**
 * Shared pairing implementation used by `pair` and `enroll`. Mints a code
 * for a specific project, prints short code + QR + URL.
 */
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

  // Prefer the user's configured baseUrl (tunnel URL, typically); fall back
  // to the CLI override; fall back to the loopback bind host (only useful
  // on same-machine setups, but honest about what we know).
  const base = opts.baseUrl ?? project.baseUrl;
  let pairUrl: string | undefined;
  if (base) {
    const clean = base.replace(/\/$/, '');
    pairUrl = `${clean}/acp/ws?agentId=${identity.agentId}#fp=${identity.fingerprint}`;
  } else {
    // Loopback pair URL — the user has to be on the same machine. Hub
    // prints a warning so nobody wastes time scanning a localhost QR
    // from another device.
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

// ── peers (per-project allowlist) ──────────────────────────────────

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

// ── help formatting ────────────────────────────────────────────────

cli.help((sections) => {
  // Rewrite the hyphen-namespaced pseudo-commands back to multi-word in the
  // printed help, so users see what they actually type.
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

cli.version('0.1.0');
cli.parse();

// ── helpers ────────────────────────────────────────────────────────

function parseEngine(raw: string): AgentEngine {
  if (raw === 'codebuddy' || raw === 'claude-code') return raw;
  throw new Error(`Invalid --engine: "${raw}". Expected "codebuddy" or "claude-code".`);
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

// Silence unused-import lint from strict TS configs.
void findProject;
void nodeSpawn;
void existsSync;
