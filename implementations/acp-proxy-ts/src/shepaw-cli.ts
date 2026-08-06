/**
 * `shepaw store …` CLI shim for external (ACP) agents.
 *
 * The shepaw app's `[implicit]` hint tells agents to read store:// URIs with
 * `shepaw store read --uri <uri-as-is>`. Built-in runtime agents have that
 * CLI in-process (Dart); external agents reached over ACP do not. This shim
 * speaks the same store HTTP API (`/api/v1`) via StoreToolsClient so the
 * hint works verbatim on both sides.
 *
 * Backend resolution mirrors session-transcript-sink.ts:
 *   NEXUSPOUCH_URL → hub peer store (SHEPAW_HUB_STORE_URL / SHEPAW_PEER_STORE=1)
 *   → http://127.0.0.1:8787 when NEXUSPOUCH_ROOT is set.
 *
 * Output is always a single JSON envelope on stdout:
 *   success: {"success":true, …}   failure: {"success":false,"error":…} (exit 1)
 * Key shapes match the Dart store namespace (content / content_base64).
 */

import { pathToFileURL } from 'node:url';
import {
  executeStoreTool,
  StoreToolsClient,
  type StoreToolResult,
} from './store-tools.js';
import { resolveHubStoreBase } from './hub-store-env.js';

const DEFAULT_NEXUSPOUCH_URL = 'http://127.0.0.1:8787';

export interface ShepawCliIO {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

/** `--key value` / `--key=value` / bare `--flag` → flags map; rest positional. */
export function parseFlags(argv: string[]): {
  positional: string[];
  flags: Record<string, string>;
} {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[body] = next;
      i += 1;
    } else {
      flags[body] = 'true';
    }
  }
  return { positional, flags };
}

async function resolveDevice(
  base: string,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<string> {
  const explicit = (
    env.SHEPAW_HUB_STORE_DEVICE ??
    env.NEXUSPOUCH_DEVICE ??
    ''
  ).trim();
  if (explicit) return explicit;
  try {
    const res = await fetchImpl(`${base}/api/v1/health`);
    if (res.ok) {
      const body = (await res.json()) as { device?: string };
      if (body.device) return body.device;
    }
  } catch {
    /* fall through */
  }
  return '0000000000000000';
}

/**
 * Pick the store backend for this environment, or undefined when no store is
 * configured. Order matches session-transcript-sink.ts.
 */
export async function resolveStoreClient(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<StoreToolsClient | undefined> {
  const hubBase = resolveHubStoreBase(env);
  const base =
    (env.NEXUSPOUCH_URL ?? '').trim() ||
    hubBase ||
    ((env.NEXUSPOUCH_ROOT ?? env.NEXUSPOUCH_MCP_ROOT ?? '').trim()
      ? DEFAULT_NEXUSPOUCH_URL
      : '');
  if (!base) return undefined;
  const token = (
    env.SHEPAW_HUB_STORE_TOKEN ??
    env.NEXUSPOUCH_ADMIN_TOKEN ??
    env.NEXUSPOUCH_TOKEN ??
    'local'
  ).trim();
  const device = await resolveDevice(base, env, fetchImpl);
  return new StoreToolsClient(base, token, device, fetchImpl);
}

const USAGE = `shepaw store — read/write store:// URIs (Nexuspouch pouch)

  shepaw store read --uri <store://…>
  shepaw store write --filename <name> --content <text>
      [--space artifacts] [--task <id>] [--context <text>] [--to-agent <id>]
  shepaw store list --uri <store://…>
  shepaw store meta --uri <store://…>

Output is a single JSON envelope: {"success":true,…} or
{"success":false,"error":…}. Cite returned store:// URIs verbatim.`;

function emit(
  io: ShepawCliIO,
  result: Record<string, unknown>,
): number {
  const ok = result.success === true;
  (io.stdout ?? ((t) => process.stdout.write(t + '\n')))(
    JSON.stringify(result),
  );
  return ok ? 0 : 1;
}

/** Map a StoreToolResult onto the Dart store-namespace envelope shape. */
function toEnvelope(out: StoreToolResult): Record<string, unknown> {
  if (!out.ok) {
    return { success: false, error: out.error ?? 'unknown error', code: out.code };
  }
  const data = (out.data ?? {}) as Record<string, unknown>;
  // read: content is base64 when encoding=base64 — match the Dart CLI's
  // content / content_base64 split.
  if (data.encoding === 'base64' && typeof data.content === 'string') {
    const { content, ...rest } = data;
    return { success: true, ...rest, content_base64: content };
  }
  return { success: true, ...data };
}

export async function runShepawCli(
  argv: string[],
  io: ShepawCliIO = {},
): Promise<number> {
  const env = io.env ?? process.env;
  const { positional, flags } = parseFlags(argv);
  const [namespace, command] = positional;

  if (flags.help === 'true' || flags.h === 'true') {
    (io.stdout ?? ((t) => process.stdout.write(t + '\n')))(USAGE);
    return 0;
  }
  if (namespace !== 'store' || !command) {
    return emit(io, {
      success: false,
      error:
        "this shepaw shim implements only 'shepaw store …' (read/write/list/meta)",
      usage: USAGE,
    });
  }

  const toolName = `store_${command}`;
  if (!['store_read', 'store_write', 'store_list', 'store_meta'].includes(toolName)) {
    return emit(io, {
      success: false,
      error: `unknown store command: ${command}`,
      usage: USAGE,
    });
  }

  const client = await resolveStoreClient(env, io.fetchImpl ?? fetch);
  if (!client) {
    return emit(io, {
      success: false,
      error:
        'no store backend configured (set NEXUSPOUCH_URL / NEXUSPOUCH_ROOT or SHEPAW_HUB_STORE_URL)',
    });
  }

  // CLI flags → tool args. `shepaw store write` defaults task to 'general',
  // matching the built-in Dart namespace.
  let args: Record<string, unknown>;
  switch (command) {
    case 'read':
    case 'list':
    case 'meta':
      if (!flags.uri) {
        return emit(io, { success: false, error: 'missing --uri' });
      }
      args = { uri: flags.uri };
      break;
    case 'write': {
      const filename = flags.filename ?? flags.name;
      if (!filename) {
        return emit(io, { success: false, error: 'missing --filename' });
      }
      if (!flags.content) {
        return emit(io, { success: false, error: 'missing --content' });
      }
      args = {
        filename,
        content: flags.content,
        task: flags.task ?? 'general',
      };
      if (flags.space) args.space = flags.space;
      if (flags.context) args.context = flags.context;
      if (flags['to-agent']) args.to_agent = flags['to-agent'];
      break;
    }
    default:
      return emit(io, { success: false, error: `unknown store command: ${command}` });
  }

  const out = await executeStoreTool(toolName, args, client);
  const envelope = toEnvelope(out);
  if (envelope.success === true && command === 'write') {
    envelope.note =
      'Shared on write (local-first, synced in background). Cite the URI verbatim.';
  }
  return emit(io, envelope);
}

const invokedAsMain = (() => {
  try {
    return process.argv[1] !== undefined &&
      import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (invokedAsMain) {
  runShepawCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stdout.write(
        JSON.stringify({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        }) + '\n',
      );
      process.exit(1);
    },
  );
}
