/**
 * Hub config (hub.json).
 *
 * Holds the list of registered instances. Atomic writes (.tmp + rename) so
 * concurrent `instance add` / `instance remove` invocations don't race to
 * produce a truncated file. 0600 on Unix (consistent with identity.json and
 * authorized_peers.json) because a list of instance labels + cwds is private
 * infrastructure metadata.
 *
 * The per-instance identity.json / authorized_peers.json / enrollments.json
 * are NOT in this file — they live in `instances/<id>/` and are managed by
 * the SDK functions directly. Hub config only knows the "business-card"
 * data: id, label, engine, cwd, port.
 *
 * Why not just one giant JSON? Two reasons:
 *   1. Per-instance SDK files are managed by shepaw-acp-sdk, which has its
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
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import { resolveEngineAvailability } from './engine-setup.js';
import { hubConfigPath, validateInstanceId, normalizeCwd, hubRoot } from './paths.js';
import { encryptEnvVars, encryptValue, decryptValue, decryptEnvVars } from './crypto.js';
import {
  ensureAgentStoreMappings,
  remapAgentWorkspace,
} from './peer/agent-store-mapping.js';
import {
  addCustomEngine,
  BUILTIN_ENGINE_IDS,
  findCustomEngine,
  isKnownEngine,
  parseCustomEngines,
  removeCustomEngine,
  updateCustomEngine,
  type CustomEngineDefinition,
  type BuiltinAgentEngine,
  CustomEngineInUseError,
  CustomEngineNotFoundError,
} from './engines.js';

export {
  BUILTIN_ENGINE_IDS,
  BUILTIN_ENGINE_LABELS,
  addCustomEngine,
  findCustomEngine,
  formatShellCommand,
  isBuiltinEngine,
  isKnownEngine,
  listEngineInfos,
  parseShellCommand,
  removeCustomEngine,
  updateCustomEngine,
  validateCustomEngineId,
  CustomEngineExistsError,
  CustomEngineInUseError,
  CustomEngineNotFoundError,
} from './engines.js';
export type {
  AgentEngine,
  BuiltinAgentEngine,
  CustomEngineDefinition,
  EngineInfo,
  EngineOverrideInstanceion,
} from './engines.js';

// ── types ──────────────────────────────────────────────────────────

/**
 * Tunnel configuration for a Shepaw Channel Service channel.
 *
 * As of the gateway-level refactor a single channel is shared across every
 * managed agent on the host: the device runs one long-lived tunnel router
 * (see `tunnel-router.ts`) that terminates the channel tunnel and forwards
 * still-Noise-encrypted WebSocket streams to the right agent's loopback port
 * based on the `/p/<instanceId>` (or `/a/<agentId>`) prefix in the URL. Set
 * this on `HubConfig.gateway.tunnel` — the per-instance `InstanceConfig.tunnel`
 * is retained for backward compatibility only (see its doc comment).
 *
 * The channel's `endpoint` alias is NOT stored here; it is resolved at
 * runtime by the tunnel router against the Channel Service. The hub only
 * needs the credentials required to authenticate as the channel owner.
 */
export interface TunnelConfig {
  /** Shepaw Channel Service base URL, e.g. "https://channel.example.com" */
  readonly serverUrl: string;
  /** Channel ID assigned by the Channel Service, e.g. "ch_abc123" */
  readonly channelId: string;
  /** HMAC-SHA256 signing secret for this channel */
  readonly secret: string;
}

/** Default loopback host the tunnel router binds its dispatch server to. */
export const DEFAULT_ROUTER_HOST = '127.0.0.1';
/** Default local port the tunnel router listens on for dispatch. */
export const DEFAULT_ROUTER_PORT = 18789;

/** Default host the peer service binds to (LAN-reachable so phones can connect). */
export const DEFAULT_PEER_HOST = '0.0.0.0';
/**
 * Default port the peer service listens on (`/peer/ws`). The Shepaw desktop
 * app claims 18792 for its own peer server, so the hub uses 18793 to coexist
 * on the same host. The actual port is advertised in the QR `local` endpoint.
 */
export const DEFAULT_PEER_PORT = 18793;

/**
 * Gateway-level (device-wide) configuration.
 *
 * This is the recommended place to configure the Channel Service tunnel: one
 * channel fronts every managed agent. The tunnel router process
 * (`shepaw-hub gateway start`) reads this, opens a single reverse tunnel, and
 * dispatches incoming `/p/<instanceId>/acp/ws` connections to the matching
 * agent's loopback port. Agents themselves bind loopback-only and no longer
 * need per-instance tunnels.
 */
export interface GatewayConfig {
  /** Shared Channel Service tunnel. Omitted when running LAN-only. */
  readonly tunnel?: TunnelConfig;
  /** Loopback host the dispatch server binds to. Default `127.0.0.1`. */
  readonly routerHost: string;
  /** Local port the dispatch server (and the tunnel's local target) uses. */
  readonly routerPort: number;
  /**
   * Device-wide default tool-call approval policy. Injected into every managed
   * agent's gateway process as `PAW_ACP_APPROVAL_*` env vars unless a instance
   * defines its own {@link InstanceConfig.approval} override.
   */
  readonly approval?: ApprovalPolicyConfig;
}

/** How the gateway decides whether a tool call needs remote review. */
export type ApprovalMode = 'ask' | 'auto' | 'custom';

/**
 * Tool-call approval policy (request #4). Lets the operator pre-decide which
 * ACP permissions are auto-approved ("skipped"), auto-denied, or always sent
 * to the Shepaw app for remote review.
 *
 * `mode`:
 *   - `ask`    — always ask (safest; ignores allow rules).
 *   - `auto`   — auto-allow everything except `denyPatterns` / `askKinds`.
 *   - `custom` — apply allow/ask/deny rules; default to ask.
 *
 * `*Kinds` are ACP tool kinds (`read`, `edit`, `delete`, `move`, `search`,
 * `execute`, `think`, `fetch`, `switch_mode`, `other`). `*Patterns` are
 * case-insensitive regexes matched against the tool title + extracted command.
 */
export interface ApprovalPolicyConfig {
  readonly mode: ApprovalMode;
  readonly allowKinds: ReadonlyArray<string>;
  readonly askKinds: ReadonlyArray<string>;
  readonly allowPatterns: ReadonlyArray<string>;
  readonly denyPatterns: ReadonlyArray<string>;
}

export interface InstanceConfig {
  /**
   * Stable agent UUID. Auto-generated at creation (`crypto.randomUUID`);
   * collision-checked against existing instances. Advertised to the Shepaw
   * app as `agent_id` via peer `agent_list` — the app must reuse this id.
   */
  readonly id: string;
  /** Display name shown in `shepaw-hub status`. Free-form string. */
  readonly label: string;
  /** Built-in or custom engine id. */
  readonly engine: string;
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
   * Channel Service URL when the instance is exposed via tunnel; empty on
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
   * @deprecated Prefer the gateway-level shared channel (`HubConfig.gateway.tunnel`).
   *
   * Legacy per-instance tunnel config. When set, the hub still injects
   * `PAW_ACP_TUNNEL_*` env vars into this instance's gateway process so it opens
   * its own dedicated channel (the pre-refactor behavior). New setups should
   * leave this empty and configure one shared channel on the gateway instead;
   * the tunnel router fronts all agents over that single channel.
   */
  readonly tunnel?: TunnelConfig;
  /**
   * Optional per-instance tool-call approval override. When set, it fully
   * replaces the gateway-level default ({@link GatewayConfig.approval}) for
   * this instance's agent. Leave unset to inherit the device-wide default.
   */
  readonly approval?: ApprovalPolicyConfig;
  /**
   * Per-instance engine credentials (API keys, auth tokens, base URLs).
   * Values are stored AES-256-GCM encrypted via `crypto.ts`; they are
   * decrypted only at process-spawn time and injected as env vars into the
   * gateway child process. Never returned in plaintext over the API.
   */
  readonly envVars: Record<string, string>;
  /**
   * When false the instance is disabled: it will not start, and paired apps
   * can re-enable it from device details. Omitted / true = enabled.
   */
  readonly enabled?: boolean;
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
 * Stored at the hub (global) level so adding a new instance with the same
 * engine can pre-fill credentials without the user having to re-enter them.
 */
export type HubCredentialCache = Partial<Record<BuiltinAgentEngine, Record<string, CredentialHint>>>;

/**
 * Per-engine override stored at the hub level. Applies to BOTH built-in and
 * custom engines (keyed by engine id). All fields optional — an engine with
 * no entry simply inherits device-wide defaults.
 *
 * Resolution precedence for tool-call approval (most specific wins):
 *   instance.approval → engineOverrides[engine].approval → gateway.approval
 *
 * `envVars` are injected at spawn time as engine-default env, merged UNDER
 * the instance's own envVars so a instance can override a single key. Values
 * are AES-256-GCM encrypted like {@link InstanceConfig.envVars}.
 */
export interface EngineOverrides {
  /** When true the engine is hidden from the new-instance dropdown and cannot start. */
  readonly disabled?: boolean;
  /** Display-name override (cosmetic; applies to built-in and custom engines). */
  readonly displayName?: string;
  /** Engine-default credentials, encrypted at rest. */
  readonly envVars?: Record<string, string>;
  /** Per-engine default tool-call approval policy. */
  readonly approval?: ApprovalPolicyConfig;
}

/** Map keyed by engine id (built-in or custom). */
export type EngineOverridesMap = Record<string, EngineOverrides>;

/**
 * Device-level peer service config. The peer service implements the
 * `shepaw://peer` responder so a Shepaw app can pair with the hub over the
 * LAN and reach every managed instance through one P2P channel.
 */
export interface PeerServiceConfig {
  /** Bind host. Default `0.0.0.0` (LAN-reachable). */
  readonly host: string;
  /** Listen port for `/peer/ws`. Default 18792 (matches the app). */
  readonly port: number;
}

export interface HubConfig {
  readonly path: string;
  readonly instances: ReadonlyArray<InstanceConfig>;
  /** User-registered local ACP CLIs. */
  readonly customEngines: ReadonlyArray<CustomEngineDefinition>;
  /** Gateway-level (device-wide) config: shared channel tunnel + router port. */
  readonly gateway?: GatewayConfig;
  /** Device-level peer service config (host/port). */
  readonly peer?: PeerServiceConfig;
  /** Per-engine overrides (disabled / displayName / envVars / approval). */
  readonly engineOverrides?: EngineOverridesMap;
  /** Last Tunnel Server URL used — pre-filled when creating a new instance. */
  readonly lastTunnelServerUrl?: string;
  /** Last Tunnel Secret hint (masked + encrypted) — pre-filled when creating a new instance. */
  readonly lastTunnelSecretHint?: CredentialHint;
  /** Per-engine credential hints for pre-filling on instance creation. */
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
  migrateLegacyInstancesDir();
  if (!existsSync(path)) {
    persist(path, [], { customEngines: [] });
    return { path, instances: [], customEngines: [] };
  }
  return loadExisting(path);
}

/**
 * One-time on-disk migration: the per-instance data directory was renamed
 * from `projects/` to `instances/`. If the new dir is absent but the legacy
 * dir exists, rename it. Idempotent — once renamed, the legacy dir is gone
 * and this is a cheap no-op (two existsSync calls). Skipped in tests that
 * pin a custom home with no legacy dir.
 */
function migrateLegacyInstancesDir(): void {
  const root = hubRoot();
  const legacy = join(root, 'projects');
  const next = join(root, 'instances');
  if (existsSync(next) || !existsSync(legacy)) return;
  try {
    renameSync(legacy, next);
  } catch {
    // If the rename fails (permissions, partial state), leave it — the hub
    // will surface missing-instance errors rather than crash on load.
  }
}

/**
 * Overwrite the hub config with a new list of instances. Atomic rename; fails
 * if the file's permission bits have been loosened (to catch accidental
 * `chmod -R 755 ~/.config/shepaw-hub`).
 */
export function saveHubConfig(path: string, config: Pick<HubConfig, 'instances' | 'customEngines' | 'lastTunnelServerUrl' | 'lastTunnelSecretHint' | 'credentialHints' | 'gateway' | 'peer' | 'engineOverrides'>): void {
  persist(path, config.instances, hubPersistMeta(config));
}

/**
 * Set or update the gateway-level (device-wide) config. Pass `tunnel: null`
 * to remove the shared channel; pass a `TunnelConfig` to set it. `routerHost`
 * / `routerPort` default to the built-in loopback values when first created.
 */
export function setHubGateway(
  config: HubConfig,
  patch: {
    tunnel?: TunnelConfig | null;
    routerHost?: string;
    routerPort?: number;
    approval?: ApprovalPolicyConfig | null;
  },
): HubConfig {
  const existing = config.gateway;
  let tunnel: TunnelConfig | undefined;
  if (patch.tunnel === null) {
    tunnel = undefined;
  } else if (patch.tunnel !== undefined) {
    tunnel = patch.tunnel;
  } else {
    tunnel = existing?.tunnel;
  }
  let approval: ApprovalPolicyConfig | undefined;
  if (patch.approval === null) {
    approval = undefined;
  } else if (patch.approval !== undefined) {
    approval = patch.approval;
  } else {
    approval = existing?.approval;
  }
  const gateway: GatewayConfig = {
    ...(tunnel !== undefined && { tunnel }),
    routerHost: patch.routerHost ?? existing?.routerHost ?? DEFAULT_ROUTER_HOST,
    routerPort: patch.routerPort ?? existing?.routerPort ?? DEFAULT_ROUTER_PORT,
    ...(approval !== undefined && { approval }),
  };
  const next: HubConfig = { ...config, gateway };
  persist(next.path, next.instances, hubPersistMeta(next));
  return next;
}

/**
 * Resolve the effective approval policy for a instance, most-specific-wins:
 * the instance's own override → the engine's override → the gateway-level
 * default. Returns undefined when none of the three is configured (the agent
 * then defaults to always-ask).
 */
export function resolveApprovalPolicy(
  config: HubConfig,
  instance: Pick<InstanceConfig, 'approval' | 'engine'>,
): ApprovalPolicyConfig | undefined {
  return (
    instance.approval ??
    config.engineOverrides?.[instance.engine]?.approval ??
    config.gateway?.approval
  );
}

/**
 * Update hub-level metadata (lastTunnelServerUrl, credentialHints) without
 * touching the instances list. Used when a instance is created with tunnel/creds
 * so subsequent instance creations can pre-fill these values.
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
  persist(next.path, next.instances, hubPersistMeta(next));
  return next;
}

export function addCustomEngineToHub(
  config: HubConfig,
  input: { id: string; displayName: string; acpCommand: string },
): HubConfig {
  const customEngines = addCustomEngine(config.customEngines, input);
  const next: HubConfig = { ...config, customEngines };
  persist(next.path, next.instances, hubPersistMeta(next));
  return next;
}

export function removeCustomEngineFromHub(config: HubConfig, id: string): HubConfig {
  const inUse = config.instances.filter((p) => p.engine === id).map((p) => p.id);
  if (inUse.length > 0) {
    throw new CustomEngineInUseError(id, inUse);
  }
  const customEngines = removeCustomEngine(config.customEngines, id);
  // Drop any override entry for the removed engine too.
  const engineOverrides = stripEngineOverride(config.engineOverrides, id);
  const next: HubConfig = { ...config, customEngines, ...(engineOverrides !== undefined && { engineOverrides }) };
  persist(next.path, next.instances, hubPersistMeta(next));
  return next;
}

/**
 * Edit a custom engine's display name and/or ACP command. Custom-only —
 * built-in engines have a fixed command (the bundled proxy CLI).
 */
export function updateCustomEngineInHub(
  config: HubConfig,
  id: string,
  patch: { displayName?: string; acpCommand?: string },
): HubConfig {
  if (findCustomEngine(config.customEngines, id) === undefined) {
    throw new CustomEngineNotFoundError(id);
  }
  const customEngines = updateCustomEngine(config.customEngines, id, patch);
  const next: HubConfig = { ...config, customEngines };
  persist(next.path, next.instances, hubPersistMeta(next));
  return next;
}

/**
 * Whether an engine id is known (built-in or registered custom) and thus
 * eligible to receive overrides.
 */
export function isKnownEngineForOverrides(
  config: HubConfig,
  id: string,
): boolean {
  return isKnownEngine(id, config.customEngines);
}

/** True when the engine is known and marked disabled via overrides. */
export function isEngineDisabled(config: HubConfig, id: string): boolean {
  return isKnownEngineForOverrides(config, id)
    && config.engineOverrides?.[id]?.disabled === true;
}

/**
 * Set or patch a per-engine override. `null` for `disabled` / `displayName` /
 * `approval` clears that field. Env vars are merged encrypted (instance-style):
 * `mergeEnvVars` (plain), `clearEnvVars`, `deleteEnvVarKey`. Throws if the
 * engine id is not known.
 */
export function setEngineOverride(
  config: HubConfig,
  id: string,
  patch: {
    disabled?: boolean | null;
    displayName?: string | null;
    approval?: ApprovalPolicyConfig | null;
    mergeEnvVars?: Record<string, string>;
    clearEnvVars?: boolean;
    deleteEnvVarKey?: string;
  },
): HubConfig {
  if (!isKnownEngineForOverrides(config, id)) {
    throw new CustomEngineNotFoundError(id);
  }
  const root = hubRoot();
  const prev = config.engineOverrides?.[id] ?? {};
  const nextOverrides = { ...prev };

  if (patch.disabled === null) {
    delete nextOverrides.disabled;
  } else if (patch.disabled !== undefined) {
    nextOverrides.disabled = patch.disabled;
  }

  if (patch.displayName === null) {
    delete nextOverrides.displayName;
  } else if (patch.displayName !== undefined) {
    const trimmed = patch.displayName.trim();
    if (trimmed.length === 0) {
      throw new Error('Display name must not be empty.');
    }
    nextOverrides.displayName = trimmed;
  }

  if (patch.approval === null) {
    delete nextOverrides.approval;
  } else if (patch.approval !== undefined) {
    nextOverrides.approval = patch.approval;
  }

  // Env var merge — same scheme as instance envVars.
  let envVars = patch.clearEnvVars ? {} : { ...(prev.envVars ?? {}) };
  if (patch.deleteEnvVarKey !== undefined) {
    const { [patch.deleteEnvVarKey]: _d, ...rest } = envVars;
    envVars = rest;
  }
  if (patch.mergeEnvVars && Object.keys(patch.mergeEnvVars).length > 0) {
    const encrypted = encryptEnvVars(patch.mergeEnvVars, root);
    envVars = { ...envVars, ...encrypted };
  }
  if (Object.keys(envVars).length > 0) {
    nextOverrides.envVars = envVars;
  } else {
    delete nextOverrides.envVars;
  }

  const engineOverrides = { ...(config.engineOverrides ?? {}), [id]: nextOverrides };
  const next: HubConfig = { ...config, engineOverrides };
  persist(next.path, next.instances, hubPersistMeta(next));
  return next;
}

/** Convenience: clear just the approval field of an engine's override. */
export function clearEngineApproval(config: HubConfig, id: string): HubConfig {
  return setEngineOverride(config, id, { approval: null });
}

/** Set one engine-default env var (encrypted). */
export function setEngineEnvVar(
  config: HubConfig,
  id: string,
  key: string,
  value: string,
): HubConfig {
  return setEngineOverride(config, id, { mergeEnvVars: { [key]: value } });
}

/** Delete one engine-default env var key. */
export function deleteEngineEnvVar(
  config: HubConfig,
  id: string,
  key: string,
): HubConfig {
  return setEngineOverride(config, id, { deleteEnvVarKey: key });
}

/** Return engine-default env var keys (values stay encrypted at rest). */
export function engineEnvVarKeys(config: HubConfig, id: string): string[] {
  return Object.keys(config.engineOverrides?.[id]?.envVars ?? {});
}

/**
 * Decrypt and return engine-default env vars for spawn-time injection.
 * Returns an empty record when the engine has no override env.
 */
export function resolveEngineEnvVars(
  config: HubConfig,
  id: string,
): Record<string, string> {
  const env = config.engineOverrides?.[id]?.envVars;
  if (env === undefined || Object.keys(env).length === 0) return {};
  return decryptEnvVars(env, hubRoot());
}

/** Remove an engine's override entry entirely, returning the new map (or undefined if empty). */
function stripEngineOverride(
  map: EngineOverridesMap | undefined,
  id: string,
): EngineOverridesMap | undefined {
  if (map === undefined || !(id in map)) return map;
  const { [id]: _removed, ...rest } = map;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/**
 * Allocate a collision-free agent UUID for a new instance.
 * Loops on the astronomically unlikely randomUUID collision with an existing id.
 */
export function allocateInstanceId(
  existingIds: ReadonlyArray<string> | ReadonlySet<string>,
): string {
  const taken = existingIds instanceof Set ? existingIds : new Set(existingIds);
  for (;;) {
    const id = randomUUID();
    if (!taken.has(id)) return id;
  }
}

/**
 * Add a instance, validating the id and checking for duplicate ids.
 * Multiple instances may share the same cwd. Returns the final HubConfig.
 * Throws InstanceExistsError if the id already exists.
 *
 * Also maps the Working Directory and agent private space into the hub store:
 *   store://workspaces/<device>/<cwd-abs>/  (symlink → cwd)
 *   store://agents/<device>/<agent-uuid>/
 */
export function addInstance(
  config: HubConfig,
  instance: Omit<InstanceConfig, 'envVars'> & { plainEnvVars?: Record<string, string> },
): HubConfig {
  validateInstanceId(instance.id);
  const root = hubRoot();
  const { plainEnvVars, ...rest } = instance;
  const normalized: InstanceConfig = {
    ...rest,
    cwd: normalizeCwd(instance.cwd),
    envVars: plainEnvVars && Object.keys(plainEnvVars).length > 0
      ? encryptEnvVars(plainEnvVars, root)
      : {},
  };

  if (config.instances.some((p) => p.id === normalized.id)) {
    throw new InstanceExistsError(
      `A instance with id "${normalized.id}" already exists. ` +
        `Pick a different id, or remove the existing one first (shepaw-hub instance remove ${normalized.id}).`,
    );
  }
  if (!Number.isInteger(normalized.port) || normalized.port <= 0 || normalized.port > 65535) {
    throw new Error(
      `Instance port must be an integer in 1..65535 (got ${String(normalized.port)}).`,
    );
  }
  const dupPort = config.instances.find((p) => p.port === normalized.port);
  if (dupPort !== undefined) {
    throw new InstanceExistsError(
      `Port ${normalized.port} is already used by instance "${dupPort.id}". ` +
        `Omit --port to let the hub pick the next free one, or choose a different port.`,
    );
  }
  if (!isKnownEngine(normalized.engine, config.customEngines)) {
    throw new Error(
      `Unknown engine "${normalized.engine}". ` +
        `Use a built-in engine or register a custom one (shepaw-hub engine add).`,
    );
  }
  if (isEngineDisabled(config, normalized.engine)) {
    throw new Error(
      `Engine "${normalized.engine}" is disabled. Enable it in the dashboard settings before adding a instance that uses it.`,
    );
  }
  const customEngine = findCustomEngine(config.customEngines, normalized.engine);
  const engineEnv = resolveEngineEnvVars(config, normalized.engine);
  const availability = resolveEngineAvailability(normalized.engine, {
    customCommand: customEngine?.command,
    cursorApiKey: normalized.engine === 'cursor' ? engineEnv.CURSOR_API_KEY : undefined,
  });
  if (!availability.available) {
    throw new Error(
      `Engine "${normalized.engine}" is not available: ${availability.unavailableReason ?? 'environment not ready'}. ` +
        'Install it under Settings → Engine Management in the dashboard.',
    );
  }

  const next = [...config.instances, normalized];
  persist(config.path, next, hubPersistMeta(config));

  try {
    ensureAgentStoreMappings({ agentId: normalized.id, cwd: normalized.cwd });
  } catch (err) {
    console.warn(
      `[shepaw-hub] Warning: failed to map store spaces for agent "${normalized.id}": ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  return { ...config, instances: next };
}

/**
 * Remove a instance by id. Throws InstanceNotFoundError if no such instance —
 * the CLI layer translates this into a user-friendly message.
 */
export function removeInstance(config: HubConfig, id: string): HubConfig {
  const filtered = config.instances.filter((p) => p.id !== id);
  if (filtered.length === config.instances.length) {
    throw new InstanceNotFoundError(
      `No instance with id "${id}". Run 'shepaw-hub instance list' to see registered instances.`,
    );
  }
  persist(config.path, filtered, hubPersistMeta(config));
  return { ...config, instances: filtered };
}

/**
 * Look up a instance by id. Returns undefined if not found; callers that
 * treat "not found" as an error should use `getInstance` which throws.
 */
export function findInstance(
  config: HubConfig,
  id: string,
): InstanceConfig | undefined {
  return config.instances.find((p) => p.id === id);
}

/** True unless the operator (or a paired app) has explicitly disabled it. */
export function isInstanceEnabled(instance: InstanceConfig): boolean {
  return instance.enabled !== false;
}

export function getInstance(config: HubConfig, id: string): InstanceConfig {
  const p = findInstance(config, id);
  if (p === undefined) {
    throw new InstanceNotFoundError(
      `No instance with id "${id}". Run 'shepaw-hub instance list' to see registered instances.`,
    );
  }
  return p;
}

/**
 * Partial update — the CLI's `instance update` uses this to change label /
 * baseUrl / extraArgs / host without having to restate the whole instance.
 * Refuses to change id or port through this path; those go through remove +
 * add to force the operator to think about the port collision implications.
 *
 * `mergeEnvVars`: plain key→value pairs to encrypt and merge into envVars.
 * `clearEnvVars`: if true, clears all existing envVars before applying mergeEnvVars.
 */
export function updateInstance(
  config: HubConfig,
  id: string,
  patch: Partial<Omit<InstanceConfig, 'id' | 'port' | 'createdAt' | 'envVars'>> & {
    mergeEnvVars?: Record<string, string>;
    clearEnvVars?: boolean;
    deleteEnvVarKey?: string;
  },
): HubConfig {
  const idx = config.instances.findIndex((p) => p.id === id);
  if (idx < 0) {
    throw new InstanceNotFoundError(`No instance with id "${id}".`);
  }
  const existing = config.instances[idx]!;
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
  if (rest.engine !== undefined && !isKnownEngine(rest.engine, config.customEngines)) {
    throw new Error(`Unknown engine "${rest.engine}".`);
  }
  if (rest.engine !== undefined && isEngineDisabled(config, rest.engine)) {
    throw new Error(
      `Engine "${rest.engine}" is disabled. Enable it before switching a instance to it.`,
    );
  }
  if (rest.engine !== undefined) {
    const customEngine = findCustomEngine(config.customEngines, rest.engine);
    const engineEnv = resolveEngineEnvVars(config, rest.engine);
    const availability = resolveEngineAvailability(rest.engine, {
      customCommand: customEngine?.command,
      cursorApiKey: rest.engine === 'cursor' ? engineEnv.CURSOR_API_KEY : undefined,
    });
    if (!availability.available) {
      throw new Error(
        `Engine "${rest.engine}" is not available: ${availability.unavailableReason ?? 'environment not ready'}. ` +
          'Install it under Settings → Engine Management in the dashboard.',
      );
    }
  }
  const next: InstanceConfig = {
    ...existing,
    ...rest,
    // Normalize cwd if changed so relative paths resolve consistently.
    cwd: rest.cwd !== undefined ? normalizeCwd(rest.cwd) : existing.cwd,
    envVars,
  };
  const nextList = [...config.instances.slice(0, idx), next, ...config.instances.slice(idx + 1)];
  persist(config.path, nextList, hubPersistMeta(config));

  if (next.cwd !== existing.cwd) {
    try {
      remapAgentWorkspace({
        agentId: next.id,
        previousCwd: existing.cwd,
        cwd: next.cwd,
      });
    } catch (err) {
      console.warn(
        `[shepaw-hub] Warning: failed to remap workspace store for agent "${next.id}": ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  return { ...config, instances: nextList };
}

/**
 * Set a single env var key on an existing instance. The value is encrypted
 * before storage. Convenience wrapper around updateInstance.
 */
export function setInstanceEnvVar(
  config: HubConfig,
  id: string,
  key: string,
  value: string,
): HubConfig {
  return updateInstance(config, id, { mergeEnvVars: { [key]: value } });
}

/**
 * Delete a single env var key from an existing instance.
 */
export function deleteInstanceEnvVar(
  config: HubConfig,
  id: string,
  key: string,
): HubConfig {
  return updateInstance(config, id, { deleteEnvVarKey: key });
}

// ── errors ─────────────────────────────────────────────────────────

export class InstanceExistsError extends Error {
  override readonly name = 'InstanceExistsError';
  constructor(message: string) { super(message); }
}

export class InstanceNotFoundError extends Error {
  override readonly name = 'InstanceNotFoundError';
  constructor(message: string) { super(message); }
}

// ── internals ──────────────────────────────────────────────────────

interface OnDiskSchema {
  version: 1;
  instances: Array<InstanceConfig>;
  customEngines?: Array<CustomEngineDefinition>;
  lastTunnelServerUrl?: string;
  lastTunnelSecretHint?: CredentialHint;
  credentialHints?: HubCredentialCache;
  gateway?: GatewayConfig;
  peer?: PeerServiceConfig;
  engineOverrides?: EngineOverridesMap;
}

function hubPersistMeta(
  config: Pick<HubConfig, 'lastTunnelServerUrl' | 'lastTunnelSecretHint' | 'credentialHints' | 'customEngines' | 'gateway' | 'peer' | 'engineOverrides'>,
): PersistOptions {
  return {
    lastTunnelServerUrl: config.lastTunnelServerUrl,
    lastTunnelSecretHint: config.lastTunnelSecretHint,
    credentialHints: config.credentialHints,
    customEngines: config.customEngines,
    gateway: config.gateway,
    peer: config.peer,
    engineOverrides: config.engineOverrides,
  };
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
  // Backward compat: hub.json pre-rename stored the array under `projects`.
  // Accept either; the new `instances` key wins. The next persist rewrites it
  // under `instances`, so this legacy read is a one-time migration.
  const instancesRaw = Array.isArray(obj.instances)
    ? obj.instances
    : Array.isArray(obj.projects)
      ? obj.projects
      : undefined;
  if (instancesRaw === undefined) {
    throw new Error(`Hub config at ${path}: 'instances' must be an array.`);
  }

  const customEngines = parseCustomEngines(obj.customEngines);
  const engineOverrides = parseEngineOverrides(obj.engineOverrides);

  const instances: InstanceConfig[] = [];
  for (let i = 0; i < instancesRaw.length; i++) {
    const raw = instancesRaw[i];
    if (raw === null || typeof raw !== 'object') {
      throw new Error(`Hub config at ${path}: entry #${i} must be a JSON object.`);
    }
    const p = raw as Record<string, unknown>;
    const entry: InstanceConfig = {
      id: requireString(p.id, `instances[${i}].id`, path),
      label: typeof p.label === 'string' ? p.label : '',
      engine: parseInstanceEngine(p.engine, customEngines, `instances[${i}].engine`, path),
      cwd: requireString(p.cwd, `instances[${i}].cwd`, path),
      port: requireNumber(p.port, `instances[${i}].port`, path),
      host: typeof p.host === 'string' ? p.host : '127.0.0.1',
      baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : '',
      extraArgs: Array.isArray(p.extraArgs)
        ? p.extraArgs.filter((x): x is string => typeof x === 'string')
        : [],
      createdAt: typeof p.createdAt === 'string' ? p.createdAt : '',
      tunnel: parseTunnelConfig(p.tunnel),
      approval: parseApprovalPolicy(p.approval),
      // Backwards compat: old instances without envVars default to empty.
      envVars: parseEnvVarsConfig(p.envVars),
      ...(p.enabled === false && { enabled: false as const }),
    };
    validateInstanceId(entry.id);
    instances.push(entry);
  }

  return {
    path,
    instances,
    customEngines,
    lastTunnelServerUrl: typeof obj.lastTunnelServerUrl === 'string' ? obj.lastTunnelServerUrl : undefined,
    lastTunnelSecretHint: parseCredentialHint(obj.lastTunnelSecretHint),
    credentialHints: parseCredentialHints(obj.credentialHints),
    gateway: parseGatewayConfig(obj.gateway),
    peer: parsePeerConfig(obj.peer),
    ...(engineOverrides !== undefined && { engineOverrides }),
  };
}

function parsePeerConfig(v: unknown): PeerServiceConfig | undefined {
  if (v === undefined || v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const host = typeof o.host === 'string' && o.host.length > 0 ? o.host : DEFAULT_PEER_HOST;
  const port = typeof o.port === 'number' && Number.isInteger(o.port) && o.port > 0 ? o.port : DEFAULT_PEER_PORT;
  return { host, port };
}

function parseGatewayConfig(v: unknown): GatewayConfig | undefined {
  if (v === undefined || v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const obj = v as Record<string, unknown>;
  const tunnel = parseTunnelConfig(obj.tunnel);
  const routerHost = typeof obj.routerHost === 'string' && obj.routerHost.length > 0
    ? obj.routerHost
    : DEFAULT_ROUTER_HOST;
  const routerPort = typeof obj.routerPort === 'number' && Number.isInteger(obj.routerPort) && obj.routerPort > 0
    ? obj.routerPort
    : DEFAULT_ROUTER_PORT;
  const approval = parseApprovalPolicy(obj.approval);
  return {
    ...(tunnel !== undefined && { tunnel }),
    routerHost,
    routerPort,
    ...(approval !== undefined && { approval }),
  };
}

const APPROVAL_KINDS = new Set([
  'read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other',
]);

function parseApprovalPolicy(v: unknown): ApprovalPolicyConfig | undefined {
  if (v === undefined || v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const mode: ApprovalMode = o.mode === 'auto' || o.mode === 'custom' ? o.mode : 'ask';
  const kinds = (x: unknown): string[] =>
    Array.isArray(x)
      ? x.filter((s): s is string => typeof s === 'string' && APPROVAL_KINDS.has(s))
      : [];
  const strs = (x: unknown): string[] =>
    Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string' && s.length > 0) : [];
  return {
    mode,
    allowKinds: kinds(o.allowKinds),
    askKinds: kinds(o.askKinds),
    allowPatterns: strs(o.allowPatterns),
    denyPatterns: strs(o.denyPatterns),
  };
}

/**
 * Parse the engineOverrides map from disk. Drops any entry whose id is not a
 * non-empty string; per-entry fields are validated defensively (unknown engine
 * ids are kept so a stale override survives a transient custom-engine removal).
 */
function parseEngineOverrides(v: unknown): EngineOverridesMap | undefined {
  if (v === undefined || v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const obj = v as Record<string, unknown>;
  const out: EngineOverridesMap = {};
  for (const [id, raw] of Object.entries(obj)) {
    if (typeof id !== 'string' || id.length === 0) continue;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const o = raw as Record<string, unknown>;
    const entry: EngineOverrides = {
      ...(o.disabled === true && { disabled: true }),
      ...(typeof o.displayName === 'string' && o.displayName.length > 0 && { displayName: o.displayName }),
      ...((o.envVars === undefined || o.envVars === null)
        ? {}
        : typeof o.envVars === 'object' && !Array.isArray(o.envVars)
          ? { envVars: parseEnvVarsConfig(o.envVars) }
          : {}),
      ...(parseApprovalPolicy(o.approval) !== undefined && { approval: parseApprovalPolicy(o.approval) }),
    };
    if (Object.keys(entry).length > 0) out[id] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

interface PersistOptions {
  lastTunnelServerUrl?: string;
  lastTunnelSecretHint?: CredentialHint;
  credentialHints?: HubCredentialCache;
  customEngines?: ReadonlyArray<CustomEngineDefinition>;
  gateway?: GatewayConfig;
  peer?: PeerServiceConfig;
  engineOverrides?: EngineOverridesMap;
}

function persist(path: string, instances: ReadonlyArray<InstanceConfig>, opts?: PersistOptions): void {
  const schema: OnDiskSchema = {
    version: 1,
    instances: [...instances],
    ...(opts?.customEngines !== undefined && { customEngines: [...opts.customEngines] }),
    ...(opts?.lastTunnelServerUrl !== undefined && { lastTunnelServerUrl: opts.lastTunnelServerUrl }),
    ...(opts?.lastTunnelSecretHint !== undefined && { lastTunnelSecretHint: opts.lastTunnelSecretHint }),
    ...(opts?.credentialHints !== undefined && { credentialHints: opts.credentialHints }),
    ...(opts?.gateway !== undefined && { gateway: opts.gateway }),
    ...(opts?.peer !== undefined && { peer: opts.peer }),
    ...(opts?.engineOverrides !== undefined && { engineOverrides: opts.engineOverrides }),
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

/**
 * Parse an instance engine id from disk.
 *
 * Unknown engines must NOT fail the whole hub.json load — a single stale or
 * forward-compatible engine (e.g. a newer built-in not yet in this process)
 * would otherwise block every other instance (peer routing, catalog, spawn).
 * Create/update paths still validate via {@link isKnownEngine}.
 */
function parseInstanceEngine(
  v: unknown,
  customEngines: ReadonlyArray<CustomEngineDefinition>,
  field: string,
  file: string,
): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`Hub config at ${file}: ${field} must be a non-empty string.`);
  }
  if (!isKnownEngine(v, customEngines)) {
    console.warn(
      `[shepaw-hub] Warning: ${field} references unknown engine "${v}" in ${file}. ` +
        `That instance will not start until the engine is registered; other instances are unaffected.`,
    );
  }
  return v;
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
  const engines: BuiltinAgentEngine[] = [...BUILTIN_ENGINE_IDS];
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
