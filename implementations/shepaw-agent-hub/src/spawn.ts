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

import type { ProjectConfig, AgentEngine } from './config.js';
import { projectPaths } from './paths.js';

// ── types ──────────────────────────────────────────────────────────

export interface ProjectState {
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
 * Start a project's gateway process. Must be called AFTER the project's
 * identity / peers / enrollments files have been resolved — those live
 * alongside state.json in the same projects/<id>/ dir.
 *
 * Idempotent-ish: if state.json claims the project is running AND the pid
 * is live, returns the existing pid without doing anything. If the pid is
 * dead, we overwrite state.json and start fresh.
 */
export async function startProject(project: ProjectConfig): Promise<{
  pid: number;
  alreadyRunning: boolean;
}> {
  const paths = projectPaths(project.id);

  // Idempotency check. If the last-known pid is still alive, treat this as
  // a no-op success. Prevents accidental double-start.
  const prior = readState(paths.statePath);
  if (prior !== undefined && prior.pid > 0 && isAlive(prior.pid)) {
    return { pid: prior.pid, alreadyRunning: true };
  }

  // Verify cwd exists; early hard-fail beats the gateway crashing on first tick.
  if (!existsSync(project.cwd)) {
    throw new Error(
      `Project cwd does not exist: ${project.cwd}. ` +
        `Create the directory or run 'shepaw-hub project update ${project.id} --cwd <path>'.`,
    );
  }

  const cliPath = resolveEngineCliPath(project.engine);

  // Open a rotating log stream. Files rotated by size OR weekly, whichever
  // comes first; keep last 7 rotated segments. Matches what a casual user
  // would get from logrotate without them having to configure anything.
  //
  // rotating-file-stream is NOT a file descriptor, so to pass it to
  // child.stdio we need to pipe() from the child's stdout/stderr. Easier
  // path: open a plain file, use that as the FD for child stdio, and let
  // rotation happen by renaming the file underneath the process (Node's
  // write stream to a renamed file keeps working on Unix; on Windows we
  // SIGHUP-style close-reopen is not trivial).
  //
  // Compromise: we open the FD directly. The rotating-file-stream is used
  // from `hub logs` on read-time and from a separate lightweight rotation
  // hook invoked by `hub logs rotate` / future cron. Simpler and 100%
  // cross-platform.
  mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
  const logFd = openSync(paths.logFile, 'a');

  try {
    const args = [
      cliPath,
      'serve',
      '--cwd', project.cwd,
      '--port', String(project.port),
      '--host', project.host,
      ...project.extraArgs,
    ];

    const child = nodeSpawn(process.execPath, args, {
      // Detached so the child survives the hub CLI exiting. On Windows this
      // also requires `windowsHide: true` to avoid a black console popping
      // up. On Unix it uses setsid to give the child its own session — it
      // becomes its own process group leader, so `ps -ef | grep shepaw` is
      // clean.
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        // Redirect SDK file-resolution to this project's isolated dir.
        // These three vars are the entire integration surface between hub
        // and the unmodified gateway binaries.
        SHEPAW_IDENTITY_PATH: paths.identityPath,
        SHEPAW_PEERS_PATH: paths.peersPath,
        SHEPAW_ENROLLMENTS_PATH: paths.enrollmentsPath,
      },
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
      port: project.port,
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
 * Stop a project's gateway. Returns 'graceful' / 'hard' / 'not-running' so
 * the CLI can surface what actually happened.
 *
 * - 'graceful' — SIGTERM was accepted and the process exited in < 5s (Unix).
 * - 'hard'     — We had to escalate (Unix SIGKILL, or Windows TerminateProcess).
 * - 'not-running' — state.json said it was running but the pid was gone.
 *                   The CLI treats this as a recoverable "already stopped".
 */
export async function stopProject(project: ProjectConfig): Promise<StopResult> {
  const paths = projectPaths(project.id);
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
export function readState(path: string): ProjectState | undefined {
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `State file at ${path} is not valid JSON: ${formatErr(err)}. ` +
        `Delete it manually and restart the project.`,
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

export function writeState(path: string, state: ProjectState): void {
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
 * Ensure a project's config directory + log dir exist, with 0700 perms.
 * Called by start and by the initial `project add` before writing identity.
 */
export function ensureProjectDir(projectId: string): void {
  const paths = projectPaths(projectId);
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
}

/**
 * Rotate the log file for a project NOW. Used by `shepaw-hub logs rotate`
 * and can be wired into a cron job. Uses rotating-file-stream's API just
 * to get a canonical "rename agent.log to agent.log.1, etc." without
 * reimplementing it.
 *
 * We keep up to 7 rotated files by size (10 MiB cap each). Older get deleted
 * by the library. If these defaults don't suit someone's workload they can
 * edit the hub's code — not worth a config flag yet.
 */
export async function rotateProjectLogs(projectId: string): Promise<void> {
  const paths = projectPaths(projectId);
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
 * packages must be installed globally too, or in the same project as the
 * hub. Standard npm workspace behavior handles this for our monorepo use.
 */
function resolveEngineCliPath(engine: AgentEngine): string {
  const require = createRequire(import.meta.url);
  // Each gateway package exposes `./cli` as a subpath export pointing at
  // `dist/cli.js`. This is a stable contract; don't reach past it into
  // `/dist/...` directly — the gateway is free to reorganize its build.
  const pkg =
    engine === 'codebuddy'
      ? 'shepaw-codebuddy-code-gateway/cli'
      : 'shepaw-claude-code-gateway/cli';
  try {
    return require.resolve(pkg);
  } catch (err) {
    throw new Error(
      `Cannot locate ${pkg}. Make sure the corresponding gateway package is ` +
        `installed alongside shepaw-hub (via npm/pnpm/yarn). ` +
        `Original error: ${formatErr(err)}`,
    );
  }
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
