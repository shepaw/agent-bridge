/**
 * Cross-platform spawn/stop for agent gateway processes.
 *
 * **Why we don't use `npm bin` or the gateway's .cmd shim**: on Windows, the
 * `shepaw-codebuddy-code` entry resolved from `npm install` is a `.cmd`
 * shim. `spawn()` with a `.cmd` target requires `shell: true`, which then
 * forces us to quote-escape paths that may contain spaces on Windows —
 * error-prone. Instead we use `require.resolve()` to find the gateway's
 * compiled CLI JS file and invoke `node <cli.js> serve ...` directly. This
 * path is identical on Windows, macOS, Linux.
 *
 * **Process supervision model**:
 *   - `start`: spawn detached, redirect stdio to a rotating log stream,
 *     record pid + started-at into state.json, then the hub exits. The agent
 *     keeps running on its own; it's not a daemon in the systemd sense, but
 *     it survives the hub CLI exiting.
 *   - `status`: read state.json → probe pid with `kill -0` (signal 0 is a
 *     cross-platform existence check in Node; `process.kill(pid, 0)` throws
 *     on Windows too when the pid is gone). Live: running. Not live:
 *     crashed or cleanly exited; logs hold the details.
 *   - `stop`:
 *       - Unix: SIGTERM, wait up to 5s for graceful shutdown, then SIGKILL.
 *       - Windows: no POSIX signals. `process.kill(pid)` on Win32 is
 *         actually `TerminateProcess` — unconditional hard kill. We accept
 *         this and flag it in the CLI output and README.
 *
 * State transitions:
 *   (no state.json) → [start] → running
 *   running → [stop(ok)] → stopped
 *   running → [child crashed] → stopped (stale pid; `status` notices)
 */

import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  closeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { createStream as createRotatingStream } from 'rotating-file-stream';

import type { InstanceConfig } from './config.js';
import {
  augmentSpawnPath,
  getCursorAcpCommand,
  resolveBinaryPath,
  resolveCursorCliBinary,
  resolveEngineAvailability,
  resolveZcodeCliBinary,
  SPAWN_PATH_PREFIXES,
} from './engine-setup.js';
import { loadOrCreateHubConfig, isEngineDisabled, resolveEngineEnvVars } from './config.js';
import { hubFanoutEnvPaths } from './pairing.js';
import { findCustomEngine, formatShellCommand, isKnownEngine } from './engines.js';
import { findBuiltinEngineDefinition } from './engine-catalog.js';
import { instancePaths, hubRoot } from './paths.js';
import { decryptEnvVars } from './crypto.js';
import { authorizePeerServiceOnInstance } from './peer/peer-auth.js';

// ── types ──────────────────────────────────────────────────────────

export interface InstanceState {
  /** PID of the gateway child process, or 0 if we've marked it stopped. */
  readonly pid: number;
  /** Port the agent was told to bind to when it was started. */
  readonly port: number;
  /** ISO 8601 when `start` was invoked. */
  readonly startedAt: string;
  /** Present only after stop completed or a crash was observed. */
  readonly stoppedAt?: string;
  /** How the last transition ended. */
  readonly lastResult?: 'graceful' | 'hard' | 'crashed';
}

export type StopResult = 'graceful' | 'hard' | 'not-running';

// ── public API ─────────────────────────────────────────────────────

/**
 * Start a instance's gateway process. Must be called AFTER the instance's
 * identity / peers / enrollments files have been resolved — those live
 * alongside state.json in the same instances/<id>/ dir.
 *
 * Idempotent-ish: if state.json claims the instance is running AND the pid
 * is live, returns the existing pid without doing anything. If the pid is
 * dead, we overwrite state.json and start fresh.
 */
export async function startInstance(instance: InstanceConfig): Promise<{
  pid: number;
  alreadyRunning: boolean;
}> {
  const paths = instancePaths(instance.id);

  if (instance.enabled === false) {
    throw new Error(
      `Instance "${instance.id}" is disabled. Enable it before starting.`,
    );
  }

  // Idempotency check. If the last-known pid is still alive, treat this as
  // a no-op success. Prevents accidental double-start.
  const prior = readState(paths.statePath);
  if (prior !== undefined && prior.pid > 0 && isAlive(prior.pid)) {
    return { pid: prior.pid, alreadyRunning: true };
  }

  // Verify cwd exists; early hard-fail beats the gateway crashing on first tick.
  if (!existsSync(instance.cwd)) {
    throw new Error(
      `Instance cwd does not exist: ${instance.cwd}. ` +
        `Create the directory or run 'shepaw-hub instance update ${instance.id} --cwd <path>'.`,
    );
  }

  const cliPath = resolveEngineCliPath();

  mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
  const logFd = openSync(paths.logFile, 'a');

  try {
    const hubCfg = loadOrCreateHubConfig();

    // Refuse to start a instance whose engine has been disabled via overrides.
    // The operator must re-enable it (dashboard settings) first.
    if (isEngineDisabled(hubCfg, instance.engine)) {
      throw new Error(
        `Engine "${instance.engine}" is disabled. ` +
          `Re-enable it in the dashboard settings before starting instance "${instance.id}".`,
      );
    }

    const customEngine = findCustomEngine(hubCfg.customEngines, instance.engine);
    if (!isKnownEngine(instance.engine, hubCfg.customEngines)) {
      throw new Error(
        `Instance "${instance.id}" uses unknown engine "${instance.engine}". ` +
          `Register it with 'shepaw-hub engine add' or upgrade Hub so the built-in engine is available. ` +
          `Other instances are not affected.`,
      );
    }
    const engineEnv = resolveEngineEnvVars(hubCfg, instance.engine);

    const availability = resolveEngineAvailability(instance.engine, {
      customCommand: customEngine?.command,
      cursorApiKey: instance.engine === 'cursor' ? engineEnv.CURSOR_API_KEY : undefined,
    });
    if (!availability.available) {
      throw new Error(
        `Engine "${instance.engine}" is not available: ${availability.unavailableReason ?? 'environment not ready'}. ` +
          'Fix credentials or install the CLI under Settings → Engine Management.',
      );
    }

    // Authorize the device-level peer service to connect to this instance's
    // /acp/ws (it acts as a Noise IK initiator to proxy agent_chat requests
    // from paired phones). Idempotent — addPeer dedupes by pubkey.
    try {
      authorizePeerServiceOnInstance(instance.id, hubCfg);
    } catch {
      // Non-fatal: peer service still works for instances where this succeeds.
    }

    const args = [
      cliPath,
      'serve',
      '--engine', instance.engine,
      '--cwd', instance.cwd,
      '--port', String(instance.port),
      '--host', instance.host,
      '--session-store-path', paths.sessionsPath,
      ...instance.extraArgs,
    ];

    if (customEngine !== undefined) {
      args.push('--engine-display-name', customEngine.displayName);
      args.push('--acp-command', formatShellCommand(customEngine.command, customEngine.args));
    } else if (instance.engine === 'cursor') {
      const cursorBin = resolveCursorCliBinary();
      if (cursorBin === null) {
        throw new Error(
          `Cursor CLI not found (agent / cursor-agent). ` +
            `Install via "brew install --cask cursor-cli" or see Hub engine settings.`,
        );
      }
      args.push('--acp-command', getCursorAcpCommand());
    }

    const instanceEnv = decryptEnvVars(instance.envVars ?? {}, hubRoot());
    // Official @agentclientprotocol/codex-acp reads CODEX_PATH; without it the
    // bundled @openai/codex under npx often fails (missing optional platform bin).
    const codexPath =
      instance.engine === 'codex'
        ? (instanceEnv.CODEX_PATH ??
          engineEnv.CODEX_PATH ??
          process.env.CODEX_PATH ??
          resolveBinaryPath('codex', [...SPAWN_PATH_PREFIXES]) ??
          undefined)
        : undefined;
    const zcodeBin =
      instance.engine === 'zcode'
        ? (instanceEnv.ZCODE_BIN ??
          engineEnv.ZCODE_BIN ??
          process.env.ZCODE_BIN ??
          resolveZcodeCliBinary() ??
          undefined)
        : undefined;

    const catalogEnv = findBuiltinEngineDefinition(instance.engine)?.spawnEnv ?? {};

    const child = nodeSpawn(process.execPath, args, {
      // Detached so the child survives the hub CLI exiting. On Windows this
      // also requires `windowsHide: true` to avoid a black console popping
      // up. On Unix it uses setsid to give the child its own session — it
      // becomes its own process group leader, so `ps -ef | grep shepaw` is
      // clean.
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
      env: augmentSpawnPath({
        ...process.env,
        // Catalog defaults (e.g. Auggie / Droid / VT Code ACP flags). Engine
        // and instance env below override these.
        ...catalogEnv,
        // Engine-default credentials (engineOverrides[engine].envVars). These
        // are the base layer: a instance can override individual keys via its
        // own envVars below. Decrypted at spawn time; never on disk plaintext.
        ...engineEnv,
        // Per-instance credentials (ANTHROPIC_API_KEY, CODEBUDDY_API_KEY, etc.).
        // Decrypted from hub.json's envVars at spawn time; never appear in
        // argv or hub.json in plaintext. Instance values override engine defaults.
        ...instanceEnv,
        ...(codexPath !== undefined && codexPath.length > 0 ? { CODEX_PATH: codexPath } : {}),
        ...(zcodeBin !== undefined && zcodeBin.length > 0 ? { ZCODE_BIN: zcodeBin } : {}),
        // Redirect SDK file-resolution to this instance's isolated dir.
        // These three vars are the entire integration surface between hub
        // and the unmodified gateway binaries.
        SHEPAW_IDENTITY_PATH: paths.identityPath,
        SHEPAW_PEERS_PATH: paths.peersPath,
        SHEPAW_ENROLLMENTS_PATH: paths.enrollmentsPath,
        ...(() => {
          const fanout = hubFanoutEnvPaths(hubCfg);
          return {
            SHEPAW_HUB_FANOUT_PEER_PATHS: fanout.peerPaths,
            SHEPAW_HUB_FANOUT_ENROLLMENT_PATHS: fanout.enrollmentPaths,
          };
        })(),
        // LEGACY per-instance tunnel. The recommended model runs one shared
        // channel at the gateway level (see `HubConfig.gateway.tunnel` and the
        // tunnel router); in that setup instances bind loopback-only and this
        // block never fires because `instance.tunnel` is unset. Retained so
        // pre-refactor instances that still carry their own channel keep
        // working. Credentials go through env vars (not argv) so they never
        // appear in `ps aux`.
        ...(instance.tunnel !== undefined
          ? {
              PAW_ACP_TUNNEL_SERVER_URL: instance.tunnel.serverUrl,
              PAW_ACP_TUNNEL_CHANNEL_ID: instance.tunnel.channelId,
              PAW_ACP_TUNNEL_SECRET: instance.tunnel.secret,
            }
          : {}),
        ...(instance.sessionMode !== undefined && instance.sessionMode.length > 0
          ? { PAW_ACP_SESSION_MODE: instance.sessionMode }
          : {}),
      }),
    });

    // unref() tells Node's event loop not to wait for this child. The hub
    // CLI can now exit and the child continues.
    child.unref();

    // Give it 200ms to prove it didn't instantly crash on argv parsing. If
    // it did, state.json will end up claiming "running" while the pid is
    // dead; the next `status` call will notice. But a brief synchronous
    // check catches obvious cases (e.g. bad engine name) at add time.
    await sleep(200);
    if (!isAlive(child.pid!)) {
      throw new Error(
        `Gateway exited immediately. Check logs:\n  ${paths.logFile}\n` +
          `Common causes: bad --extra-args, missing API key env var, invalid cwd.`,
      );
    }

    writeState(paths.statePath, {
      pid: child.pid!,
      port: instance.port,
      startedAt: new Date().toISOString(),
    });
    return { pid: child.pid!, alreadyRunning: false };
  } finally {
    // Close the log FD in the parent — the child inherited its own
    // duplicate via stdio. Leaving it open leaks a descriptor per spawn.
    try { closeSync(logFd); } catch { /* ignore */ }
  }
}

/**
 * Stop a instance's gateway. Returns 'graceful' / 'hard' / 'not-running' so
 * the CLI can surface what actually happened.
 *
 * - 'graceful' — SIGTERM was accepted and the process exited in < 5s (Unix).
 * - 'hard'     — We had to escalate (Unix SIGKILL, or Windows TerminateProcess).
 * - 'not-running' — state.json said it was running but the pid was gone.
 *                   The CLI treats this as a recoverable "already stopped".
 */
export interface RestartInstanceResult {
  readonly id: string;
  readonly wasRunning: boolean;
  readonly stopResult?: StopResult;
  readonly startResult?: { pid: number; alreadyRunning: boolean };
  readonly error?: string;
}

/**
 * Restart a single instance when it is running: stop, then start again.
 * Stopped instances are left untouched.
 */
export async function restartInstance(
  instance: InstanceConfig,
  hooks?: { onStopped?: (instanceId: string) => void },
): Promise<RestartInstanceResult> {
  let wasRunning = false;
  try {
    const paths = instancePaths(instance.id);
    const prior = readState(paths.statePath);
    wasRunning = prior !== undefined && prior.pid > 0 && isAlive(prior.pid);
  } catch (err) {
    return { id: instance.id, wasRunning: false, error: formatErr(err) };
  }

  if (!wasRunning) {
    return { id: instance.id, wasRunning: false };
  }

  try {
    const stopResult = await stopInstance(instance);
    hooks?.onStopped?.(instance.id);
    const startResult = await startInstance(instance);
    return { id: instance.id, wasRunning: true, stopResult, startResult };
  } catch (err) {
    return { id: instance.id, wasRunning: true, error: formatErr(err) };
  }
}

/**
 * Restart every configured instance sequentially. Only instances that are
 * currently running are stopped and started again; stopped instances are
 * left untouched.
 */
export async function restartAllInstances(
  hooks?: { onStopped?: (instanceId: string) => void },
): Promise<RestartInstanceResult[]> {
  const cfg = loadOrCreateHubConfig();
  const results: RestartInstanceResult[] = [];
  for (const instance of cfg.instances) {
    ensureInstanceDir(instance.id);
    results.push(await restartInstance(instance, hooks));
  }
  return results;
}

export async function stopInstance(instance: InstanceConfig): Promise<StopResult> {
  const paths = instancePaths(instance.id);
  const prior = readState(paths.statePath);
  if (prior === undefined || prior.pid === 0 || !isAlive(prior.pid)) {
    // Nothing to do, but normalize state.json so later `status` calls are
    // consistent.
    if (prior !== undefined) {
      writeState(paths.statePath, {
        ...prior,
        pid: 0,
        stoppedAt: new Date().toISOString(),
        lastResult: 'crashed',
      });
    }
    return 'not-running';
  }

  const pid = prior.pid;

  if (process.platform === 'win32') {
    // No SIGTERM on Windows. `process.kill(pid)` maps to TerminateProcess —
    // unconditional. Flush log, exit. The gateway's in-flight WebSocket
    // sessions will see a TCP RST rather than a clean WS close; the app
    // surfaces that as a transport error and reconnects.
    try { process.kill(pid); } catch { /* already gone */ }
    writeState(paths.statePath, {
      ...prior,
      pid: 0,
      stoppedAt: new Date().toISOString(),
      lastResult: 'hard',
    });
    return 'hard';
  }

  // Unix: polite signal first.
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Raced — child died between isAlive() and here.
    writeState(paths.statePath, {
      ...prior,
      pid: 0,
      stoppedAt: new Date().toISOString(),
      lastResult: 'crashed',
    });
    return 'not-running';
  }

  // Poll for up to 5s. 50ms interval is fine-grained enough for a CLI to
  // feel snappy without burning CPU.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      writeState(paths.statePath, {
        ...prior,
        pid: 0,
        stoppedAt: new Date().toISOString(),
        lastResult: 'graceful',
      });
      return 'graceful';
    }
    await sleep(50);
  }

  // Gateway ignored SIGTERM — escalate. The gateway shouldn't do this; if
  // it does, the bug lives there, not here.
  try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
  writeState(paths.statePath, {
    ...prior,
    pid: 0,
    stoppedAt: new Date().toISOString(),
    lastResult: 'hard',
  });
  return 'hard';
}

/**
 * Read state.json if present, returning `undefined` if not. Corrupted state
 * files throw — manual intervention required (unlikely; we always write
 * atomically).
 */
export function readState(path: string): InstanceState | undefined {
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `State file at ${path} is not valid JSON: ${formatErr(err)}. ` +
        `Delete it manually and restart the instance.`,
    );
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const obj = parsed as Record<string, unknown>;
  return {
    pid: typeof obj.pid === 'number' ? obj.pid : 0,
    port: typeof obj.port === 'number' ? obj.port : 0,
    startedAt: typeof obj.startedAt === 'string' ? obj.startedAt : '',
    stoppedAt: typeof obj.stoppedAt === 'string' ? obj.stoppedAt : undefined,
    lastResult: (obj.lastResult === 'graceful' || obj.lastResult === 'hard' || obj.lastResult === 'crashed')
      ? obj.lastResult
      : undefined,
  };
}

export function writeState(path: string, state: InstanceState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Cross-platform pid liveness check. `process.kill(pid, 0)` sends no signal
 * on Unix but validates the pid (ESRCH if dead, EPERM if alive but owned by
 * another user — we treat EPERM as alive because we can't prove otherwise).
 * On Windows, Node's kill(pid, 0) returns true iff the process exists.
 */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // EPERM means the process exists but we lack permission to signal it —
    // still "alive" from our perspective.
    return e.code === 'EPERM';
  }
}

/**
 * Ensure a instance's config directory + log dir exist, with 0700 perms.
 * Called by start and by the initial `instance add` before writing identity.
 */
export function ensureInstanceDir(instanceId: string): void {
  const paths = instancePaths(instanceId);
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
}

/**
 * Rotate the log file for a instance NOW. Used by `shepaw-hub logs rotate`
 * and can be wired into a cron job. Uses rotating-file-stream's API just
 * to get a canonical "rename agent.log to agent.log.1, etc." without
 * reimplementing it.
 *
 * We keep up to 7 rotated files by size (10 MiB cap each). Older get deleted
 * by the library. If these defaults don't suit someone's workload they can
 * edit the hub's code — not worth a config flag yet.
 */
export async function rotateInstanceLogs(instanceId: string): Promise<void> {
  const paths = instancePaths(instanceId);
  if (!existsSync(paths.logFile)) return;

  // rotating-file-stream rotates on write; we force rotation by creating a
  // stream configured to rotate-on-every-byte and writing an empty string.
  // That feels hacky but it's the public API they intend for this purpose.
  // Library is well-tested and used in production elsewhere.
  const stream = createRotatingStream('agent.log', {
    path: paths.logsDir,
    size: '1B',           // rotate at first byte — effectively "rotate now"
    interval: undefined,
    maxFiles: 7,
    compress: false,      // stay simple; gzip adds CPU+complexity
  });
  try {
    await new Promise<void>((resolve, reject) => {
      stream.write('', (err: Error | null | undefined) => {
        if (err) reject(err);
        else resolve();
      });
    });
  } finally {
    await new Promise<void>((resolve) => stream.end(() => resolve()));
  }
}

// ── internals ──────────────────────────────────────────────────────

/**
 * Resolve the gateway CLI's entry JS path for a given engine. We use
 * `createRequire(import.meta.url)` so this ESM module can still use
 * `require.resolve` — that API is how you robustly locate a sibling
 * package's published entry file without hard-coding relative paths.
 *
 * When this code runs from a globally installed `shepaw-hub`, the gateway
 * packages must be installed globally too, or in the same instance as the
 * hub. Standard npm workspace behavior handles this for our monorepo use.
 */
function resolveEngineCliPath(): string {
  const require = createRequire(import.meta.url);
  const pkg = 'shepaw-acp-proxy-gateway/cli';
  try {
    return require.resolve(pkg);
  } catch (err) {
    throw new Error(
      `Cannot locate ${pkg}. Make sure shepaw-acp-proxy-gateway is ` +
        `installed alongside shepaw-hub (via npm/pnpm/yarn). ` +
        `Original error: ${formatErr(err)}`,
    );
  }
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
