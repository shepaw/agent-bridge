/**
 * Hub config (hub.json).
 *
 * Holds the list of registered projects. Atomic writes (.tmp + rename) so
 * concurrent `project add` / `project remove` invocations don't race to
 * produce a truncated file. 0600 on Unix (consistent with identity.json and
 * authorized_peers.json) because a list of project labels + cwds is private
 * infrastructure metadata.
 *
 * The per-project identity.json / authorized_peers.json / enrollments.json
 * are NOT in this file — they live in `projects/<id>/` and are managed by
 * the SDK functions directly. Hub config only knows the "business-card"
 * data: id, label, engine, cwd, port.
 *
 * Why not just one giant JSON? Two reasons:
 *   1. Per-project SDK files are managed by shepaw-acp-sdk, which has its
 *      own atomic-write + permissions + schema logic. Re-implementing it
 *      at the hub level would fork responsibility.
 *   2. The gateway child process needs to read its own identity/peers files
 *      directly via env vars. It doesn't know about hub.json.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import { hubConfigPath, validateProjectId, normalizeCwd, hubRoot } from './paths.js';
import { encryptEnvVars, encryptValue, decryptValue } from './crypto.js';

// ── types ──────────────────────────────────────────────────────────

/**
 * Which gateway binary the hub spawns for this project.
 *
 * Keeping this as a string union (not an enum) so adding a new engine later
 * only requires editing this file and `resolveEngineCliPath` in spawn.ts.
 */
export type AgentEngine = 'codebuddy' | 'claude-code' | 'codex' | 'opencode';

/**
 * Tunnel configuration for a Shepaw Channel Service channel.
 *
 * One channel per agent — a single channel cannot be shared across multiple
 * agents simultaneously. The channel's `endpoint` is NOT stored here; it is
 * set by the Channel Service when the channel is created. The hub only needs
 * the credentials required to authenticate as the channel owner.
 *
 * These values are injected into the gateway child process as env vars
 * (`PAW_ACP_TUNNEL_*`) so they never appear in `ps aux` argv output.
 */
export interface TunnelConfig {
  /** Shepaw Channel Service base URL, e.g. "https://channel.example.com" */
  readonly serverUrl: string;
  /** Channel ID assigned by the Channel Service, e.g. "ch_abc123" */
  readonly channelId: string;
  /** HMAC-SHA256 signing secret for this channel */
  readonly secret: string;
}

export interface ProjectConfig {
  /** User-chosen identifier. Validated against `paths.validateProjectId`. */
  readonly id: string;
  /** Display name shown in `shepaw-hub status`. Free-form string. */
  readonly label: string;
  /** Gateway implementation to spawn. */
  readonly engine: AgentEngine;
  /** Absolute path to the working directory the gateway runs in. */
  readonly cwd: string;
  /** Local TCP port to bind to. Allocated by `ports.nextFreePort` on add. */
  readonly port: number;
  /**
   * Local host interface to bind to. Default `127.0.0.1` (loopback only). If
   * the gateway must be reachable on the LAN without going through a tunnel,
   * the operator sets this to `0.0.0.0`. Mirrors the gateway's `--host` flag.
   */
  readonly host: string;
  /**
   * Optional: base URL to print in enrollment QRs. Typically a Shepaw
   * Channel Service URL when the project is exposed via tunnel; empty on
   * LAN-only setups (in which case `shepaw-hub pair` still works but prints
   * a URL based on host:port).
   */
  readonly baseUrl: string;
  /**
   * Optional: extra CLI args passed through to the gateway's `serve` command.
   * Empty by default. Example: `['--model', 'claude-opus-4-7', '--max-turns', '20']`.
   * Unknown-to-hub but important-to-gateway config goes here.
   */
  readonly extraArgs: ReadonlyArray<string>;
  /** ISO 8601 timestamp for audit / `status --verbose`. */
  readonly createdAt: string;
  /**
   * Optional tunnel config. When set, the hub injects `PAW_ACP_TUNNEL_*`
   * env vars into the gateway process and auto-derives `baseUrl` from
   * `${serverUrl}/proxy/${channelId}` if `baseUrl` is not explicitly set.
   */
  readonly tunnel?: TunnelConfig;
  /**
   * Per-project engine credentials (API keys, auth tokens, base URLs).
   * Values are stored AES-256-GCM encrypted via `crypto.ts`; they are
   * decrypted only at process-spawn time and injected as env vars into the
   * gateway child process. Never returned in plaintext over the API.
   */
  readonly envVars: Record<string, string>;
}

/**
 * Per-engine credential hint stored in hub.json.
 * `masked` is the display string (e.g. "sk-ant-ab***789").
 * `encrypted` holds the full encrypted value (same scheme as envVars).
 */
export interface CredentialHint {
  readonly masked: string;
  readonly encrypted: string;
}

/**
 * Hub-level credential cache: per engine, per env-var key.
 * Stored at the hub (global) level so adding a new project with the same
 * engine can pre-fill credentials without the user having to re-enter them.
 */
export type HubCredentialCache = Partial<Record<AgentEngine, Record<string, CredentialHint>>>;

export interface HubConfig {
  readonly path: string;
  readonly projects: ReadonlyArray<ProjectConfig>;
  /** Last Tunnel Server URL used — pre-filled when creating a new project. */
  readonly lastTunnelServerUrl?: string;
  /** Last Tunnel Secret hint (masked + encrypted) — pre-filled when creating a new project. */
  readonly lastTunnelSecretHint?: CredentialHint;
  /** Per-engine credential hints for pre-filling on project creation. */
  readonly credentialHints?: HubCredentialCache;
}

export interface LoadHubOptions {
  /** Override hub config path (tests use this). */
  path?: string;
}

// ── public API ─────────────────────────────────────────────────────

/**
 * Load hub.json from disk, or create an empty one if missing. The returned
 * object is a snapshot — callers mutate via `saveHubConfig` or the
 * convenience helpers below.
 */
export function loadOrCreateHubConfig(opts: LoadHubOptions = {}): HubConfig {
  const path = opts.path ?? hubConfigPath();
  if (!existsSync(path)) {
    persist(path, [], {});
    return { path, projects: [] };
  }
  return loadExisting(path);
}

/**
 * Overwrite the hub config with a new list of projects. Atomic rename; fails
 * if the file's permission bits have been loosened (to catch accidental
 * `chmod -R 755 ~/.config/shepaw-hub`).
 */
export function saveHubConfig(path: string, projects: ReadonlyArray<ProjectConfig>): void {
  persist(path, projects);
}

/**
 * Update hub-level metadata (lastTunnelServerUrl, credentialHints) without
 * touching the projects list. Used when a project is created with tunnel/creds
 * so subsequent project creations can pre-fill these values.
 */
export function updateHubMeta(
  config: HubConfig,
  meta: { lastTunnelServerUrl?: string; lastTunnelSecretHint?: CredentialHint; credentialHints?: HubCredentialCache },
): HubConfig {
  const next: HubConfig = {
    ...config,
    ...(meta.lastTunnelServerUrl !== undefined && { lastTunnelServerUrl: meta.lastTunnelServerUrl }),
    ...(meta.lastTunnelSecretHint !== undefined && { lastTunnelSecretHint: meta.lastTunnelSecretHint }),
    ...(meta.credentialHints !== undefined && { credentialHints: meta.credentialHints }),
  };
  persist(next.path, next.projects, {
    lastTunnelServerUrl: next.lastTunnelServerUrl,
    lastTunnelSecretHint: next.lastTunnelSecretHint,
    credentialHints: next.credentialHints,
  });
  return next;
}

/**
 * Add a project, validating the id and checking for duplicate ids AND
 * duplicate cwds (user error: same project registered twice under different
 * ids). Returns the final HubConfig. Throws ProjectExistsError on duplicates.
 */
export function addProject(
  config: HubConfig,
  project: Omit<ProjectConfig, 'envVars'> & { plainEnvVars?: Record<string, string> },
): HubConfig {
  validateProjectId(project.id);
  const root = hubRoot();
  const { plainEnvVars, ...rest } = project;
  const normalized: ProjectConfig = {
    ...rest,
    cwd: normalizeCwd(project.cwd),
    envVars: plainEnvVars && Object.keys(plainEnvVars).length > 0
      ? encryptEnvVars(plainEnvVars, root)
      : {},
  };

  if (config.projects.some((p) => p.id === normalized.id)) {
    throw new ProjectExistsError(
      `A project with id "${normalized.id}" already exists. ` +
        `Pick a different id, or remove the existing one first (shepaw-hub project remove ${normalized.id}).`,
    );
  }
  const dupCwd = config.projects.find((p) => p.cwd === normalized.cwd);
  if (dupCwd !== undefined) {
    throw new ProjectExistsError(
      `Project "${dupCwd.id}" is already registered at cwd "${normalized.cwd}". ` +
        `Registering the same directory twice is almost always a mistake — ` +
        `remove the old one first, or pick a different cwd.`,
    );
  }
  if (!Number.isInteger(normalized.port) || normalized.port <= 0 || normalized.port > 65535) {
    throw new Error(
      `Project port must be an integer in 1..65535 (got ${String(normalized.port)}).`,
    );
  }
  const dupPort = config.projects.find((p) => p.port === normalized.port);
  if (dupPort !== undefined) {
    throw new ProjectExistsError(
      `Port ${normalized.port} is already used by project "${dupPort.id}". ` +
        `Omit --port to let the hub pick the next free one, or choose a different port.`,
    );
  }

  const next = [...config.projects, normalized];
  persist(config.path, next, {
    lastTunnelServerUrl: config.lastTunnelServerUrl,
    lastTunnelSecretHint: config.lastTunnelSecretHint,
    credentialHints: config.credentialHints,
  });
  return { path: config.path, projects: next, lastTunnelServerUrl: config.lastTunnelServerUrl, lastTunnelSecretHint: config.lastTunnelSecretHint, credentialHints: config.credentialHints };
}

/**
 * Remove a project by id. Throws ProjectNotFoundError if no such project —
 * the CLI layer translates this into a user-friendly message.
 */
export function removeProject(config: HubConfig, id: string): HubConfig {
  const filtered = config.projects.filter((p) => p.id !== id);
  if (filtered.length === config.projects.length) {
    throw new ProjectNotFoundError(
      `No project with id "${id}". Run 'shepaw-hub project list' to see registered projects.`,
    );
  }
  persist(config.path, filtered, {
    lastTunnelServerUrl: config.lastTunnelServerUrl,
    lastTunnelSecretHint: config.lastTunnelSecretHint,
    credentialHints: config.credentialHints,
  });
  return { path: config.path, projects: filtered, lastTunnelServerUrl: config.lastTunnelServerUrl, lastTunnelSecretHint: config.lastTunnelSecretHint, credentialHints: config.credentialHints };
}

/**
 * Look up a project by id. Returns undefined if not found; callers that
 * treat "not found" as an error should use `getProject` which throws.
 */
export function findProject(
  config: HubConfig,
  id: string,
): ProjectConfig | undefined {
  return config.projects.find((p) => p.id === id);
}

export function getProject(config: HubConfig, id: string): ProjectConfig {
  const p = findProject(config, id);
  if (p === undefined) {
    throw new ProjectNotFoundError(
      `No project with id "${id}". Run 'shepaw-hub project list' to see registered projects.`,
    );
  }
  return p;
}

/**
 * Partial update — the CLI's `project update` uses this to change label /
 * baseUrl / extraArgs / host without having to restate the whole project.
 * Refuses to change id or port through this path; those go through remove +
 * add to force the operator to think about the port collision implications.
 *
 * `mergeEnvVars`: plain key→value pairs to encrypt and merge into envVars.
 * `clearEnvVars`: if true, clears all existing envVars before applying mergeEnvVars.
 */
export function updateProject(
  config: HubConfig,
  id: string,
  patch: Partial<Omit<ProjectConfig, 'id' | 'port' | 'createdAt' | 'envVars'>> & {
    mergeEnvVars?: Record<string, string>;
    clearEnvVars?: boolean;
    deleteEnvVarKey?: string;
  },
): HubConfig {
  const idx = config.projects.findIndex((p) => p.id === id);
  if (idx < 0) {
    throw new ProjectNotFoundError(`No project with id "${id}".`);
  }
  const existing = config.projects[idx]!;
  const root = hubRoot();

  // Build updated envVars
  let envVars = patch.clearEnvVars ? {} : { ...existing.envVars };
  if (patch.deleteEnvVarKey !== undefined) {
    const { [patch.deleteEnvVarKey]: _, ...rest } = envVars;
    envVars = rest;
  }
  if (patch.mergeEnvVars && Object.keys(patch.mergeEnvVars).length > 0) {
    const encrypted = encryptEnvVars(patch.mergeEnvVars, root);
    envVars = { ...envVars, ...encrypted };
  }

  const { mergeEnvVars: _m, clearEnvVars: _c, deleteEnvVarKey: _d, ...rest } = patch;
  const next: ProjectConfig = {
    ...existing,
    ...rest,
    // Normalize cwd if changed so relative paths resolve consistently.
    cwd: rest.cwd !== undefined ? normalizeCwd(rest.cwd) : existing.cwd,
    envVars,
  };
  const nextList = [...config.projects.slice(0, idx), next, ...config.projects.slice(idx + 1)];
  persist(config.path, nextList, {
    lastTunnelServerUrl: config.lastTunnelServerUrl,
    lastTunnelSecretHint: config.lastTunnelSecretHint,
    credentialHints: config.credentialHints,
  });
  return { path: config.path, projects: nextList, lastTunnelServerUrl: config.lastTunnelServerUrl, lastTunnelSecretHint: config.lastTunnelSecretHint, credentialHints: config.credentialHints };
}

/**
 * Set a single env var key on an existing project. The value is encrypted
 * before storage. Convenience wrapper around updateProject.
 */
export function setProjectEnvVar(
  config: HubConfig,
  id: string,
  key: string,
  value: string,
): HubConfig {
  return updateProject(config, id, { mergeEnvVars: { [key]: value } });
}

/**
 * Delete a single env var key from an existing project.
 */
export function deleteProjectEnvVar(
  config: HubConfig,
  id: string,
  key: string,
): HubConfig {
  return updateProject(config, id, { deleteEnvVarKey: key });
}

// ── errors ─────────────────────────────────────────────────────────

export class ProjectExistsError extends Error {
  override readonly name = 'ProjectExistsError';
  constructor(message: string) { super(message); }
}

export class ProjectNotFoundError extends Error {
  override readonly name = 'ProjectNotFoundError';
  constructor(message: string) { super(message); }
}

// ── internals ──────────────────────────────────────────────────────

interface OnDiskSchema {
  version: 1;
  projects: Array<ProjectConfig>;
  lastTunnelServerUrl?: string;
  lastTunnelSecretHint?: CredentialHint;
  credentialHints?: HubCredentialCache;
}

function loadExisting(path: string): HubConfig {
  if (process.platform !== 'win32') {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new Error(
        `Hub config at ${path} has mode ${mode.toString(8).padStart(3, '0')}; ` +
          `expected 0600. Refusing to load — 'chmod 600 ${path}'.`,
      );
    }
  }

  const raw = readFileSync(path, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Hub config at ${path} is not valid JSON: ${formatErr(err)}`,
    );
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`Hub config at ${path}: root must be a JSON object.`);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new Error(
      `Hub config at ${path}: unsupported 'version' ${String(obj.version)} (expected 1).`,
    );
  }
  if (!Array.isArray(obj.projects)) {
    throw new Error(`Hub config at ${path}: 'projects' must be an array.`);
  }

  const projects: ProjectConfig[] = [];
  for (let i = 0; i < obj.projects.length; i++) {
    const raw = obj.projects[i];
    if (raw === null || typeof raw !== 'object') {
      throw new Error(`Hub config at ${path}: entry #${i} must be a JSON object.`);
    }
    const p = raw as Record<string, unknown>;
    // Fill in defaults for optional fields so older configs keep working
    // after we add new fields.
    const entry: ProjectConfig = {
      id: requireString(p.id, `projects[${i}].id`, path),
      label: typeof p.label === 'string' ? p.label : '',
      engine: requireEngine(p.engine, `projects[${i}].engine`, path),
      cwd: requireString(p.cwd, `projects[${i}].cwd`, path),
      port: requireNumber(p.port, `projects[${i}].port`, path),
      host: typeof p.host === 'string' ? p.host : '127.0.0.1',
      baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : '',
      extraArgs: Array.isArray(p.extraArgs)
        ? p.extraArgs.filter((x): x is string => typeof x === 'string')
        : [],
      createdAt: typeof p.createdAt === 'string' ? p.createdAt : '',
      tunnel: parseTunnelConfig(p.tunnel),
      // Backwards compat: old projects without envVars default to empty.
      envVars: parseEnvVarsConfig(p.envVars),
    };
    validateProjectId(entry.id);
    projects.push(entry);
  }

  return {
    path,
    projects,
    lastTunnelServerUrl: typeof obj.lastTunnelServerUrl === 'string' ? obj.lastTunnelServerUrl : undefined,
    lastTunnelSecretHint: parseCredentialHint(obj.lastTunnelSecretHint),
    credentialHints: parseCredentialHints(obj.credentialHints),
  };
}

interface PersistOptions {
  lastTunnelServerUrl?: string;
  lastTunnelSecretHint?: CredentialHint;
  credentialHints?: HubCredentialCache;
}

function persist(path: string, projects: ReadonlyArray<ProjectConfig>, opts?: PersistOptions): void {
  const schema: OnDiskSchema = {
    version: 1,
    projects: [...projects],
    ...(opts?.lastTunnelServerUrl !== undefined && { lastTunnelServerUrl: opts.lastTunnelServerUrl }),
    ...(opts?.lastTunnelSecretHint !== undefined && { lastTunnelSecretHint: opts.lastTunnelSecretHint }),
    ...(opts?.credentialHints !== undefined && { credentialHints: opts.credentialHints }),
  };

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(schema, null, 2), { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function requireString(v: unknown, field: string, file: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`Hub config at ${file}: ${field} must be a non-empty string.`);
  }
  return v;
}

function requireNumber(v: unknown, field: string, file: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`Hub config at ${file}: ${field} must be a finite number.`);
  }
  return v;
}

function requireEngine(v: unknown, field: string, file: string): AgentEngine {
  if (v === 'codebuddy' || v === 'claude-code' || v === 'codex' || v === 'opencode') return v;
  throw new Error(
    `Hub config at ${file}: ${field} must be "codebuddy", "claude-code", "codex", or "opencode" (got ${JSON.stringify(v)}).`,
  );
}

function parseEnvVarsConfig(v: unknown): Record<string, string> {
  if (v === undefined || v === null || typeof v !== 'object' || Array.isArray(v)) return {};
  const obj = v as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(obj)) {
    if (typeof val === 'string') out[k] = val;
  }
  return out;
}

function parseTunnelConfig(v: unknown): TunnelConfig | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object') return undefined;
  const obj = v as Record<string, unknown>;
  if (typeof obj.serverUrl !== 'string' || obj.serverUrl.length === 0) return undefined;
  if (typeof obj.channelId !== 'string' || obj.channelId.length === 0) return undefined;
  if (typeof obj.secret !== 'string' || obj.secret.length === 0) return undefined;
  return { serverUrl: obj.serverUrl, channelId: obj.channelId, secret: obj.secret };
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function parseCredentialHint(v: unknown): CredentialHint | undefined {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const h = v as Record<string, unknown>;
  if (typeof h.masked === 'string' && typeof h.encrypted === 'string') {
    return { masked: h.masked, encrypted: h.encrypted };
  }
  return undefined;
}

function parseCredentialHints(v: unknown): HubCredentialCache | undefined {
  if (v === undefined || v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const obj = v as Record<string, unknown>;
  const out: HubCredentialCache = {};
  const engines: AgentEngine[] = ['codebuddy', 'claude-code', 'codex', 'opencode'];
  for (const engine of engines) {
    const hints = obj[engine];
    if (hints === null || typeof hints !== 'object' || Array.isArray(hints)) continue;
    const hintsObj = hints as Record<string, unknown>;
    const engineHints: Record<string, CredentialHint> = {};
    for (const [key, hint] of Object.entries(hintsObj)) {
      if (hint === null || typeof hint !== 'object' || Array.isArray(hint)) continue;
      const h = hint as Record<string, unknown>;
      if (typeof h.masked === 'string' && typeof h.encrypted === 'string') {
        engineHints[key] = { masked: h.masked, encrypted: h.encrypted };
      }
    }
    if (Object.keys(engineHints).length > 0) {
      out[engine] = engineHints;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
