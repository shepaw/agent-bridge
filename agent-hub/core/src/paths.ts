/**
 * Filesystem layout for the hub.
 *
 * ```
 * $SHEPAW_HUB_HOME (or ~/.config/shepaw-hub/)
 * ├── hub.json                       — top-level config; list of instances
 * ├── enrollments.json               — hub-wide pairing codes (device pairing)
 * └── projects/                      — on-disk dir kept as `projects/` for compat
 *     └── <instance-id>/
 *         ├── identity.json           — per-instance X25519 static keypair
 *         ├── authorized_peers.json   — per-instance allowlist
 *         ├── enrollments.json        — per-instance pairing-code store
 *         ├── state.json              — pid / port / startedAt / exitCode
 *         ├── sessions.json           — Shepaw session_id → upstream ACP session_id
 *         └── logs/
 *             └── agent.log           — stdout+stderr from the gateway child
 * ```
 *
 * **Per-instance isolation is the whole point.** Each instance has its own
 * identity (X25519 keypair) so compromising one instance's keys does NOT
 * grant impersonation of any other instance. Each instance has its own peers
 * list so revoking a device from instance A leaves instance B's pairing with
 * that same device intact. The hub is purely a supervisor/config layer; the
 * gateway binaries it spawns are unmodified.
 *
 * **Config dir resolution** (highest precedence first):
 *   1. `$SHEPAW_HUB_HOME`                          — explicit override
 *   2. `$XDG_CONFIG_HOME/shepaw-hub/`              — XDG compliance on Linux
 *   3. `~/.config/shepaw-hub/`                     — always-available default
 *
 * We intentionally use `.config/` on Windows too (falling under `%USERPROFILE%`)
 * rather than `%APPDATA%` because the rest of the SDK's identity.json already
 * lives there. Consistency trumps Windows-idiomaticity; users who care can set
 * `SHEPAW_HUB_HOME` or `XDG_CONFIG_HOME`.
 */

import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';

export interface InstancePaths {
  readonly root: string;
  readonly identityPath: string;
  readonly peersPath: string;
  readonly enrollmentsPath: string;
  readonly statePath: string;
  readonly sessionsPath: string;
  readonly logsDir: string;
  readonly logFile: string;
}

/**
 * Root directory of the hub's data. Does NOT create it — callers that need
 * the dir on disk call `ensureDir(hubRoot())` or rely on the write-path
 * functions in config.ts to mkdir-recursive on persist.
 */
export function hubRoot(): string {
  const explicit = process.env.SHEPAW_HUB_HOME;
  if (explicit !== undefined && explicit.length > 0) {
    // Not validating isAbsolute — relative paths work too, tests sometimes
    // want that. Resolution happens when a file is opened.
    return explicit;
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && xdg.length > 0 ? xdg : join(homedir(), '.config');
  return join(base, 'shepaw-hub');
}

export function hubConfigPath(root: string = hubRoot()): string {
  return join(root, 'hub.json');
}

export function hubEnrollmentsPath(root: string = hubRoot()): string {
  return join(root, 'enrollments.json');
}

/** State file for the device-level tunnel router process. */
export function gatewayStatePath(root: string = hubRoot()): string {
  return join(root, 'gateway-state.json');
}

/** Directory holding the tunnel router's rotating log. */
export function gatewayLogsDir(root: string = hubRoot()): string {
  return join(root, 'gateway-logs');
}

/** Log file for the device-level tunnel router process. */
export function gatewayLogFile(root: string = hubRoot()): string {
  return join(gatewayLogsDir(root), 'gateway.log');
}

/**
 * Derive every file path for a given instance. Does NOT create the directory —
 * callers that persist via `config.ts` / spawn logic mkdir on write.
 *
 * `instanceId` is trusted to be validated (see `validateInstanceId`); we don't
 * re-validate here because this function is called from many sites and
 * double-validation just obscures the error source.
 */
export function instancePaths(instanceId: string, root: string = hubRoot()): InstancePaths {
  // On-disk directory stays `projects/` for backward compatibility with
  // existing identity/peers/sessions data. Only the code concept was renamed
  // to "instance"; the storage path is an implementation detail.
  const instanceRoot = join(root, 'projects', instanceId);
  return {
    root: instanceRoot,
    identityPath: join(instanceRoot, 'identity.json'),
    peersPath: join(instanceRoot, 'authorized_peers.json'),
    enrollmentsPath: join(instanceRoot, 'enrollments.json'),
    statePath: join(instanceRoot, 'state.json'),
    sessionsPath: join(instanceRoot, 'sessions.json'),
    logsDir: join(instanceRoot, 'logs'),
    logFile: join(instanceRoot, 'logs', 'agent.log'),
  };
}

/**
 * Validate a instance id supplied by the user on the CLI.
 *
 * Rules (intentionally strict — these strings end up as directory names on
 * three operating systems, potentially in shell commands, and sometimes in
 * log prefixes):
 *
 *   - 1..64 chars
 *   - ASCII letters, digits, hyphen, underscore only
 *   - cannot start with a hyphen (would be mistaken for a CLI flag)
 *   - cannot be a single dot or contain '..' (path traversal defense)
 *
 * On Windows, additionally reject reserved device names (CON, PRN, NUL, etc.)
 * — these would cause `mkdir instances/con` to fail mysteriously.
 */
export function validateInstanceId(id: string): void {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('Instance id must be a non-empty string.');
  }
  if (id.length > 64) {
    throw new Error(`Instance id too long (${id.length} > 64 chars): "${id}".`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
    throw new Error(
      `Instance id must be ASCII letters/digits/underscore/hyphen, ` +
        `starting with letter or digit (got "${id}").`,
    );
  }
  if (id.includes('..')) {
    throw new Error(`Instance id cannot contain "..": "${id}".`);
  }
  if (process.platform === 'win32') {
    const reserved = new Set([
      'CON', 'PRN', 'AUX', 'NUL',
      'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
      'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
    ]);
    if (reserved.has(id.toUpperCase())) {
      throw new Error(
        `"${id}" is a reserved device name on Windows and cannot be used as a instance id.`,
      );
    }
  }
}

/**
 * Defensive normalizer for user-supplied cwd values. Resolves relative paths
 * against process.cwd() and verifies the result is absolute; we do NOT
 * require the directory to exist at add time — an operator may pre-register
 * a instance before cloning the repo. Existence is checked at `start` time.
 */
export function normalizeCwd(cwd: string): string {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error('Instance cwd must be a non-empty string.');
  }
  // Expand ~ to home directory before checking if absolute
  let expanded = cwd;
  if (cwd.startsWith('~')) {
    expanded = cwd === '~' ? homedir() : join(homedir(), cwd.slice(2));
  }
  if (isAbsolute(expanded)) return expanded;
  return join(process.cwd(), expanded);
}
