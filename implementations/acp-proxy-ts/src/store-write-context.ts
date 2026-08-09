/**
 * Per-turn store write context for the `shepaw store` CLI shim.
 *
 * The ACP gateway process is long-lived; channel/session changes every chat
 * turn. We write a small JSON file the CLI reads as fallback for
 * `--owner` / `--channel` when the agent omits flags.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

export interface StoreWriteContext {
  owner?: string;
  channel?: string;
  agent_id?: string;
  updated_at?: string;
}

export function defaultStoreContextPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.SHEPAW_STORE_CONTEXT_FILE ?? '').trim();
  if (explicit) return explicit;
  const uid =
    typeof process.getuid === 'function' ? String(process.getuid()) : 'shared';
  return join(tmpdir(), `shepaw-acp-proxy-${uid}`, 'store-context.json');
}

export function writeStoreWriteContext(
  ctx: StoreWriteContext,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const path = defaultStoreContextPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const payload: StoreWriteContext = {
    ...ctx,
    updated_at: new Date().toISOString(),
  };
  writeFileSync(path, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  return path;
}

export function readStoreWriteContext(
  env: NodeJS.ProcessEnv = process.env,
): StoreWriteContext | undefined {
  const path = defaultStoreContextPath(env);
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as StoreWriteContext;
    return raw && typeof raw === 'object' ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve owner / channel for a runtime write from flags, env, then context file.
 */
export function resolveStoreWriteScope(opts: {
  flags?: Record<string, string>;
  env?: NodeJS.ProcessEnv;
}): { owner?: string; channel?: string; agentId?: string } {
  const flags = opts.flags ?? {};
  const env = opts.env ?? process.env;
  const file = readStoreWriteContext(env);

  const agentId =
    trim(flags.agent_id) ||
    trim(flags.agent) ||
    trim(env.SHEPAW_STORE_AGENT_ID) ||
    trim(file?.agent_id);

  const owner =
    trim(flags.owner) ||
    trim(flags.owner_id) ||
    trim(env.SHEPAW_STORE_OWNER) ||
    trim(file?.owner) ||
    agentId;

  const channel =
    trim(flags.channel_id) ||
    trim(flags.channel) ||
    trim(env.SHEPAW_STORE_CHANNEL) ||
    trim(file?.channel);

  return { owner, channel, agentId };
}

function trim(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const s = v.trim();
  return s.length > 0 ? s : undefined;
}
