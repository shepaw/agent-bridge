/**
 * `shepaw-hub doctor` — pre-flight diagnostics for a fresh (or broken) setup.
 *
 * Check list, fast by default (`--full` adds engine version + remote auth
 * probes, which spawn processes / do HTTP and can take seconds):
 *   1. Node.js version vs the supported range (repo package.json `engines`)
 *   2. Hub config directory + hub.json
 *   3. `shepaw-acp-proxy-gateway` resolvable — spawn.ts `require.resolve`s it
 *   4. Engine CLIs on PATH, honoring disabled flags
 *   5. Per instance: cwd exists, running state, port conflicts, crash flag
 *
 * Returns the number of hard failures so the CLI can set a non-zero exit
 * code — setup scripts and bug reports can gate on `shepaw-hub doctor`.
 */

import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { createRequire } from 'node:module';

import {
  hubRoot,
  hubConfigPath,
  instancePaths,
  isEngineDisabled,
  listEngineInfos,
  loadOrCreateHubConfig,
  probeInstanceRuntime,
  resolveEngineAvailability,
  resolveEngineEnvVars,
  type HubConfig,
} from '@shepaw/agent-hub-core';

/** Keep in sync with the root package.json `engines.node` range. */
const NODE_RANGE = '>=18.17.0';

interface DoctorOptions {
  full?: boolean;
}

interface Reporter {
  ok(message: string): void;
  warn(message: string): void;
  fail(message: string): void;
}

function makeReporter(): Reporter & { failures: number; warnings: number } {
  const r = {
    failures: 0,
    warnings: 0,
    ok(message: string) {
      console.log(`  ✓ ${message}`);
    },
    warn(message: string) {
      r.warnings += 1;
      console.log(`  ⚠ ${message}`);
    },
    fail(message: string) {
      r.failures += 1;
      console.log(`  ✗ ${message}`);
    },
  };
  return r;
}

function nodeVersionStatus(version: string): 'too-old' | 'ok' | 'unknown' {
  const m = /^v?(\d+)\.(\d+)\./.exec(version);
  if (m === null) return 'unknown';
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major < 18 || (major === 18 && minor < 17)) return 'too-old';
  return 'ok';
}

/** True when something accepts TCP connections on 127.0.0.1:<port>. */
function probeTcp(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: '127.0.0.1', port });
    const done = (listening: boolean) => {
      sock.destroy();
      resolve(listening);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(timeoutMs, () => done(false));
  });
}

function checkNode(r: Reporter): void {
  console.log('\nNode.js');
  switch (nodeVersionStatus(process.version)) {
    case 'ok':
      r.ok(`${process.version} (requires ${NODE_RANGE})`);
      break;
    case 'too-old':
      r.fail(`${process.version} is below the required range ${NODE_RANGE} — upgrade Node.js`);
      break;
    default:
      r.warn(`unrecognized Node version string: ${process.version}`);
  }
}

function checkHubConfig(r: Reporter): HubConfig | undefined {
  console.log('\nHub config');
  const configPath = hubConfigPath();
  if (!existsSync(configPath)) {
    r.fail(`hub.json not found at ${configPath} — run \`shepaw-hub init\``);
    return undefined;
  }
  try {
    const cfg = loadOrCreateHubConfig();
    r.ok(`${configPath} (${cfg.instances.length} instance(s), root ${hubRoot()})`);
    return cfg;
  } catch (err) {
    r.fail(`cannot read ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function checkGatewayPackage(r: Reporter): void {
  console.log('\nGateway package');
  const require = createRequire(import.meta.url);
  try {
    const resolved = require.resolve('shepaw-acp-proxy-gateway/cli');
    r.ok(`shepaw-acp-proxy-gateway → ${resolved}`);
  } catch {
    r.fail(
      'cannot resolve shepaw-acp-proxy-gateway — reinstall the CLI ' +
        '(`npm install -g shepaw-agent-hub`)',
    );
  }
}

function checkEngines(r: Reporter, cfg: HubConfig | undefined, full: boolean): void {
  console.log(full ? '\nEngines (full probes)' : '\nEngines');
  const infos = listEngineInfos(cfg?.customEngines ?? []);
  for (const info of infos) {
    const disabled = cfg !== undefined && isEngineDisabled(cfg, info.id);
    // decryptEnvVars can fail on a damaged secrets file — a diagnostics
    // command must not die on it; just probe without the key.
    let cursorApiKey: string | undefined;
    if (info.id === 'cursor') {
      try {
        cursorApiKey =
          (cfg !== undefined ? resolveEngineEnvVars(cfg, 'cursor')['CURSOR_API_KEY'] : undefined) ??
          process.env.CURSOR_API_KEY;
      } catch {
        cursorApiKey = process.env.CURSOR_API_KEY;
      }
    }
    const avail = resolveEngineAvailability(info.id, {
      disabled,
      customCommand: info.builtin ? undefined : info.acpCommand,
      cursorApiKey,
      skipVersion: !full,
      skipRemoteAuthProbe: !full,
    });
    if (avail.available) {
      r.ok(`${info.id}`);
    } else if (disabled) {
      r.ok(`${info.id} (disabled)`);
    } else {
      r.warn(`${info.id}: ${avail.unavailableReason ?? 'not available'}`);
    }
  }
}

async function checkInstances(r: Reporter, cfg: HubConfig | undefined): Promise<void> {
  if (cfg === undefined) return;
  console.log('\nInstances');
  if (cfg.instances.length === 0) {
    r.ok('none registered yet — `shepaw-hub project add <id> --engine <e> --cwd <dir>`');
    return;
  }
  for (const p of cfg.instances) {
    if (!existsSync(p.cwd)) {
      r.fail(`${p.id}: working directory does not exist: ${p.cwd}`);
      continue;
    }
    const st = await probeInstanceRuntime(p);
    if (st.running) {
      r.ok(`${p.id}: running (pid ${st.pid ?? '?'}, ${p.host}:${p.port}, engine ${p.engine})`);
      continue;
    }
    if (st.lastResult === 'crashed') {
      r.warn(`${p.id}: last run crashed — see ${instancePaths(p.id).logFile}`);
      continue;
    }
    if (await probeTcp(p.port)) {
      r.fail(`${p.id}: stopped but port ${p.port} is already in use by another process`);
      continue;
    }
    r.ok(`${p.id}: stopped, port ${p.port} free`);
  }
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<number> {
  const full = opts.full === true;
  const r = makeReporter();

  console.log('shepaw-hub doctor' + (full ? ' (--full)' : ''));
  checkNode(r);
  const cfg = checkHubConfig(r);
  checkGatewayPackage(r);
  checkEngines(r, cfg, full);
  await checkInstances(r, cfg);

  console.log(
    `\n${r.failures} problem(s), ${r.warnings} warning(s).` +
      (r.failures === 0 ? ' Ready to pair: shepaw-hub pair' : ''),
  );
  return r.failures;
}
