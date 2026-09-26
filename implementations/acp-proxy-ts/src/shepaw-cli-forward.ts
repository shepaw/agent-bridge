/**
 * Hub PATH shim → paired App CLI execution (`/api/v1/cli/execute`).
 *
 * Foreign `store://` and every non-Hub-native namespace run on the phone
 * through CliExecutionGate (same contract as ACP hub.cli.execute).
 */

import { resolveHubStoreBase } from './hub-store-env.js';
import { defaultStoreContextPath, resolveStoreWriteScope } from './store-write-context.js';

/**
 * A local hub that stops answering must fail the shim with an error.
 * Otherwise the CLI invocation never returns and the agent looks hung.
 */
const HUB_HTTP_TIMEOUT_MS = 30_000;
/** Probes are best-effort — they must not add a stall of their own. */
const HUB_PROBE_TIMEOUT_MS = 5_000;

export function hubForwardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = (env.SHEPAW_HUB_CLI_FORWARD ?? '').trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off') return false;
  if (flag === '1' || flag === 'true' || flag === 'on') return true;
  return resolveHubStoreBase(env) !== undefined;
}

export async function resolveHubDeviceId(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const explicit = (
    env.SHEPAW_HUB_STORE_DEVICE ??
    env.NEXUSPOUCH_DEVICE ??
    ''
  ).trim();
  if (explicit) return explicit.toLowerCase();
  const hubBase = resolveHubStoreBase(env);
  if (!hubBase) return '';
  try {
    const res = await fetchImpl(`${hubBase}/api/v1/health`, {
      signal: AbortSignal.timeout(HUB_PROBE_TIMEOUT_MS),
    });
    if (res.ok) {
      const body = (await res.json()) as { device?: string };
      if (body.device) return body.device.trim().toLowerCase();
    }
  } catch {
    /* fall through */
  }
  return '';
}

/**
 * Caller may not set identity — same set as Dart `HubCliExecute`. Dropped
 * before scope resolution too, so `--agent_id forged` cannot pick which Hub
 * engine row the App authenticates as.
 */
export const IGNORED_IDENTITY_FLAGS = [
  'agent_id',
  'agent',
  'owner',
  'owner_id',
  'channel_id',
  'channel',
];

export type CliExecuteBuild =
  | { ok: true; payload: Record<string, unknown>; warnings: string[] }
  | { ok: false; error: string; warnings: string[] };

export function buildCliExecutePayload(opts: {
  namespace: string;
  subcommand: string;
  flags: Record<string, string>;
  env?: NodeJS.ProcessEnv;
}): CliExecuteBuild {
  const env = opts.env ?? process.env;
  const dropped = Object.keys(opts.flags).filter((key) =>
    IGNORED_IDENTITY_FLAGS.includes(key),
  );
  const contextPath = defaultStoreContextPath(env);
  const warnings = dropped.length
    ? [
        `ignoring ${dropped
          .map((key) => `--${key}`)
          .join(', ')}: executor identity is never taken from caller flags - it comes from SHEPAW_STORE_AGENT_ID or ${contextPath}`,
      ]
    : [];
  const scope = resolveStoreWriteScope({
    flags: Object.fromEntries(
      Object.entries(opts.flags).filter(
        ([key]) => !IGNORED_IDENTITY_FLAGS.includes(key),
      ),
    ),
    env: opts.env,
  });
  const agentId = (scope.agentId ?? '').trim();
  if (!agentId) {
    return {
      ok: false,
      error:
        `Missing executor agent id. Caller flags cannot set it (${IGNORED_IDENTITY_FLAGS.map(
          (key) => `--${key}`,
        ).join(', ')} are dropped by design); ` +
          `set SHEPAW_STORE_AGENT_ID, or run through the ACP gateway which writes ${contextPath} each turn.`,
      warnings,
    };
  }
  const payload: Record<string, unknown> = {
    agent_id: agentId,
    namespace: opts.namespace,
    subcommand: opts.subcommand,
    flags: { ...opts.flags },
  };
  const sessionId = (scope.channel ?? '').trim();
  if (sessionId) payload.session_id = sessionId;
  return { ok: true, payload, warnings };
}

export async function postCliExecute(
  payload: Record<string, unknown>,
  opts: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<Record<string, unknown>> {
  const env = opts.env ?? process.env;
  const hubBase = resolveHubStoreBase(env);
  if (!hubBase) {
    return {
      ok: false,
      error:
        'no Hub store URL (set SHEPAW_HUB_STORE_URL or SHEPAW_PEER_STORE=1); command must run via the paired App',
    };
  }
  const token = (
    env.SHEPAW_HUB_STORE_TOKEN ??
    env.NEXUSPOUCH_ADMIN_TOKEN ??
    env.NEXUSPOUCH_TOKEN ??
    ''
  ).trim();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Awaited<ReturnType<typeof fetchImpl>>;
  try {
    res = await fetchImpl(`${hubBase}/api/v1/cli/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(HUB_HTTP_TIMEOUT_MS),
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      return {
        ok: false,
        error: `Hub did not answer within ${HUB_HTTP_TIMEOUT_MS / 1000}s`,
      };
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return {
    ok: false,
    error: text.trim() || `cli execute HTTP ${res.status}`,
  };
}

/** Map App / gate JSON (`ok`) onto shim stdout (`success`). */
export function appCliRespToEnvelope(
  out: Record<string, unknown>,
): Record<string, unknown> {
  const err = typeof out.error === 'string' ? out.error.trim() : '';
  if (out.ok === false || (err && out.success !== true)) {
    return { success: false, ...out };
  }
  if (out.success === false) {
    return { success: false, ...out };
  }
  return { success: true, ...out };
}
