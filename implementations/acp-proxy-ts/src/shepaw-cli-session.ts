/**
 * Hub PATH shim for `shepaw chat session create` /
 * `shepaw chat group session create`.
 *
 * Hub cannot create App channels locally. POST /api/v1/chat/session-create
 * (peer-session-create.ts) forwards to the paired phone, which runs the same
 * services as the in-process Dart CLI and attaches the switch card.
 */

import { resolveHubStoreBase } from './hub-store-env.js';
import { isSessionCreateCommand } from './shepaw-cli-route.js';
import { resolveStoreWriteScope } from './store-write-context.js';

export type SessionCreateKind = 'dm' | 'group';

export function sessionCreateKind(
  namespace: string | undefined,
  subcommand: string,
): SessionCreateKind | undefined {
  if (!namespace || !isSessionCreateCommand(namespace, subcommand)) {
    return undefined;
  }
  return subcommand === 'group.session.create' ? 'group' : 'dm';
}

export function buildSessionCreatePayload(opts: {
  kind: SessionCreateKind;
  flags: Record<string, string>;
  env?: NodeJS.ProcessEnv;
}): { ok: true; payload: Record<string, unknown> } | { ok: false; error: string } {
  const flags = opts.flags;
  const scope = resolveStoreWriteScope({ flags, env: opts.env });
  const channelId = (scope.channel ?? '').trim();
  if (!channelId) {
    return {
      ok: false,
      error:
        'Missing --channel (or SHEPAW_STORE_CHANNEL / store-context.json channel)',
    };
  }

  const reason = (flags.reason ?? '').trim();
  if (!reason) {
    return { ok: false, error: 'Missing required flag: --reason' };
  }

  const summary = (flags.summary ?? '').trim();
  const handoffRaw = flags['handoff-json'] ?? flags.handoff_json ?? '';
  const handoffUri = (flags['handoff-uri'] ?? flags.handoff_uri ?? '').trim();
  let handoff: Record<string, unknown> | undefined;
  if (handoffRaw.trim()) {
    try {
      const decoded = JSON.parse(handoffRaw) as unknown;
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
        return { ok: false, error: '--handoff-json must be a JSON object' };
      }
      handoff = decoded as Record<string, unknown>;
    } catch (err) {
      return {
        ok: false,
        error: `Invalid --handoff-json: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (opts.kind === 'dm' && !summary && !handoff) {
    return { ok: false, error: 'Provide --summary or --handoff-json' };
  }
  if (opts.kind === 'group' && !handoff && !handoffUri) {
    return { ok: false, error: 'Provide --handoff-json or --handoff-uri' };
  }

  const agentId = (scope.agentId ?? '').trim();
  if (!agentId) {
    return {
      ok: false,
      error:
        'Missing executor agent id (--agent_id or SHEPAW_STORE_AGENT_ID / store-context.json)',
    };
  }
  const agentName = (flags.agent_name ?? flags.agent ?? agentId).trim() || agentId;

  return {
    ok: true,
    payload: {
      kind: opts.kind,
      channel_id: channelId,
      agent_id: agentId,
      agent_name: agentName,
      reason,
      ...(flags['reason-detail']?.trim()
        ? { reason_detail: flags['reason-detail'].trim() }
        : {}),
      ...(summary ? { summary } : {}),
      ...(handoff ? { handoff } : {}),
      ...(handoffUri ? { handoff_uri: handoffUri } : {}),
      post_first_message: flags['no-first-message'] !== 'true',
      suggest_switch: flags['no-switch-card'] !== 'true',
    },
  };
}

export async function postSessionCreate(
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
      error:
        'no Hub store URL (set SHEPAW_HUB_STORE_URL or SHEPAW_PEER_STORE=1); session create must run via the paired App',
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
  const res = await fetchImpl(`${hubBase}/api/v1/chat/session-create`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
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
    error: text.trim() || `session-create HTTP ${res.status}`,
  };
}
