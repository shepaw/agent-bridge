/**
 * Nexuspouch store tools for gateway-side execution (M1.5).
 *
 * Self-contained HTTP client for the store_* tool surface backed by a
 * Nexuspouch node's /api/v1 (Bearer token). Designed to be injected into the
 * gateway tool pipeline later; today agents can already reach the same tools
 * through the agent-side MCP config (examples/mcp/).
 *
 * Write path uses the store frame API (write.begin → write.chunk → commit)
 * with sha256 verification, mirroring the MCP server implementation.
 *
 * Product artifacts default to `runtime/<owner>/<channel>/artifacts/<task>/<file>`
 * (aligned with the Shepaw App ArtifactService). Pass `space: 'artifacts'` for
 * legacy flat paths.
 */

import {
  buildArtifactRelPath,
  formatStoreMarkdownLink,
  safeStoreFilename,
} from './store-runtime-path.js';

export interface StoreToolArgs {
  [key: string]: unknown;
}

export interface StoreToolResult {
  ok: boolean;
  error?: string;
  code?: string;
  data?: unknown;
}

export interface StoreToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const storeToolDefs: StoreToolDef[] = [
  {
    name: 'store_write',
    description:
      'Write a file to the local store pouch and return its store:// URI ' +
      '(prefer runtime: store://runtime/<device>/<owner>/<channel>/artifacts/<task>/<file>). ' +
      'Local-first; when a master is set, mirrored over the peer channel.',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'File name (no leading /, no ..)' },
        content: { type: 'string' },
        space: {
          type: 'string',
          enum: [
            'runtime',
            'artifacts',
            'files',
            'public',
            'attachments',
            'backups',
            'memory',
            'sessions',
            'workspaces',
            'agents',
          ],
          default: 'runtime',
        },
        task: { type: 'string', description: 'Optional task folder (default general)' },
        owner: {
          type: 'string',
          description: 'runtime owner (agent id or group id); defaults from env/context',
        },
        channel: {
          type: 'string',
          description: 'runtime channel / session id; defaults from env/context',
        },
        agent_id: {
          type: 'string',
          description: 'Alias for owner when writing under the agent',
        },
        context: {
          type: 'string',
          description: 'If set (or to_agent), commit via handoff.create (M3)',
        },
        to_agent: {
          type: 'string',
          description: 'Optional handoff recipient agent id',
        },
      },
      required: ['filename', 'content'],
    },
  },
  {
    name: 'store_read',
    description:
      'Read a file by store:// URI (store://<space>/<device>/<path>). ' +
      'Pass URIs verbatim. After device pairing, remote device IDs are readable over the peer channel ' +
      '(prefer live owner; fall back to master mirror).',
    inputSchema: {
      type: 'object',
      properties: { uri: { type: 'string' } },
      required: ['uri'],
    },
  },
  {
    name: 'store_meta',
    description:
      'Resolve a store:// URI and return metadata (kind, size, sha256). Pass URIs verbatim.',
    inputSchema: {
      type: 'object',
      properties: { uri: { type: 'string' } },
      required: ['uri'],
    },
  },
  {
    name: 'store_list',
    description:
      'List a store directory by store:// URI (store://<space>/<device>/<prefix>). ' +
      'Use depth=1 (default) to browse one folder level at a time — required for ' +
      'cross-agent trees such as store://agents/<device>/ then store://agents/<device>/<agent-uuid>/. ' +
      'Pass depth=0 for a full recursive file listing. Paired remote devices are readable over the peer channel.',
    inputSchema: {
      type: 'object',
      properties: {
        uri: {
          type: 'string',
          description:
            'Directory URI. Space root: store://agents/<device> ; agent folder: store://agents/<device>/<agent-uuid>/',
        },
        depth: {
          type: 'integer',
          description:
            'Max folder levels to return below the URI (1 = immediate children only, includes kind:dir). ' +
            '0 = full recursive files-only. Default 1 for layer-by-layer browse.',
          default: 1,
          minimum: 0,
        },
      },
      required: ['uri'],
    },
  },
];

export class StoreToolsClient {
  constructor(
    readonly base: string,
    readonly token: string,
    readonly device: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async json(path: string, init?: RequestInit): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      ...((init?.headers as Record<string, string>) ?? {}),
    };
    const res = await this.fetchImpl(`${this.base}${path}`, { ...init, headers });
    const body = await res.text();
    if (!res.ok) {
      let code = `http_${res.status}`;
      let message = body;
      try {
        const parsed = JSON.parse(body) as { error?: string; message?: string };
        if (parsed.error) {
          code = parsed.error;
          message = parsed.message ?? body;
        }
      } catch {
        /* keep raw */
      }
      throw new StoreToolsError(code, message);
    }
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }

  private async storeOp(op: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const out = (await this.json('/api/v1/store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, payload }),
    })) as { op?: string; code?: string; message?: string; data?: Record<string, unknown> };
    if (out.op === 'error') {
      throw new StoreToolsError(out.code ?? 'error', out.message ?? '');
    }
    return out.data ?? {};
  }

  async write(args: StoreToolArgs): Promise<StoreToolResult> {
    try {
      const filename = String(args.filename ?? '');
      const content = String(args.content ?? '');
      if (!filename) return { ok: false, code: 'bad_op', error: 'filename required' };
      const space = String(args.space ?? 'runtime').trim() || 'runtime';
      const explicitTask =
        args.task != null && String(args.task).trim()
          ? String(args.task)
          : undefined;
      // Default `general` only for product artifact layouts. Other spaces
      // (sessions, files, …) keep nested filenames when task is omitted.
      const task =
        explicitTask ??
        (space === 'runtime' || space === 'artifacts' ? 'general' : undefined);
      const ownerRaw =
        (typeof args.owner === 'string' && args.owner.trim()) ||
        (typeof args.owner_id === 'string' && args.owner_id.trim()) ||
        (typeof args.agent_id === 'string' && args.agent_id.trim()) ||
        undefined;
      const channelRaw =
        (typeof args.channel === 'string' && args.channel.trim()) ||
        (typeof args.channel_id === 'string' && args.channel_id.trim()) ||
        undefined;
      const path = buildArtifactRelPath({
        space,
        filename,
        task,
        owner: ownerRaw || undefined,
        channel: channelRaw || undefined,
      });
      if (path.startsWith('/') || path.split('/').includes('..')) {
        return { ok: false, code: 'bad_path', error: 'invalid path' };
      }
      const bytes = new TextEncoder().encode(content);
      const sha = await sha256Hex(bytes);
      const begin = await this.storeOp('write.begin', {
        space,
        path,
        size: bytes.length,
        sha256: sha,
      });
      const uploadId = String(begin.upload_id ?? '');
      if (!uploadId) return { ok: false, code: 'internal', error: 'missing upload_id' };
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
        const chunk = bytes.subarray(offset, Math.min(offset + 64 * 1024, bytes.length));
        await this.storeOp('write.chunk', {
          upload_id: uploadId,
          offset,
          data: Buffer.from(chunk).toString('base64'),
        });
      }
      const context =
        typeof args.context === 'string' && args.context.trim()
          ? String(args.context)
          : undefined;
      const toAgent =
        typeof args.to_agent === 'string' && args.to_agent.trim()
          ? String(args.to_agent)
          : undefined;
      const uri = `store://${space}/${this.device}/${path}`;
      const displayName = safeStoreFilename(filename);
      const reference = formatStoreMarkdownLink(displayName, uri);
      if (context || toAgent) {
        const handoffPayload: Record<string, unknown> = {
          space,
          upload_ids: [uploadId],
        };
        if (context) handoffPayload.context = context;
        if (toAgent) handoffPayload.to_agent = toAgent;
        const handoff = await this.storeOp('handoff.create', handoffPayload);
        const handoffUri = String(handoff.handoff_uri ?? uri);
        return {
          ok: true,
          data: {
            uri: handoffUri,
            reference: formatStoreMarkdownLink(displayName, handoffUri),
            space,
            path,
            size: bytes.length,
            sha256: sha,
            state: handoff.state ?? 'published',
            handoff,
          },
        };
      }
      await this.storeOp('commit', { space, upload_ids: [uploadId] });
      return {
        ok: true,
        data: {
          uri,
          reference,
          space,
          path,
          size: bytes.length,
          sha256: sha,
        },
      };
    } catch (e) {
      return toResultError(e);
    }
  }

  async read(args: StoreToolArgs): Promise<StoreToolResult> {
    try {
      const uri = String(args.uri ?? '');
      if (!uri) return { ok: false, code: 'bad_op', error: 'uri required' };
      const meta = (await this.json(`/api/v1/uri/resolve?uri=${encodeURIComponent(uri)}`)) as {
        meta?: { size?: number };
      };
      const size = meta.meta?.size ?? 0;
      const max = 512 * 1024;
      const take = Math.max(1, Math.min(size, max));
      const res = await this.fetchImpl(
        `${this.base}/api/v1/read?uri=${encodeURIComponent(uri)}&offset=0&length=${take}`,
        { headers: { Authorization: `Bearer ${this.token}` } },
      );
      if (!res.ok) {
        throw new StoreToolsError('http_' + res.status, await res.text());
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const truncated = size > buf.length;
      const text = buf.toString('utf8');
      const encoding = buf.length > 0 && !text.includes('\uFFFD') ? 'text' : 'base64';
      return {
        ok: true,
        data: {
          uri,
          size,
          truncated,
          encoding,
          content: encoding === 'text' ? text : buf.toString('base64'),
        },
      };
    } catch (e) {
      return toResultError(e);
    }
  }

  async meta(args: StoreToolArgs): Promise<StoreToolResult> {
    try {
      const uri = String(args.uri ?? '');
      if (!uri) return { ok: false, code: 'bad_op', error: 'uri required' };
      return { ok: true, data: await this.json(`/api/v1/uri/resolve?uri=${encodeURIComponent(uri)}`) };
    } catch (e) {
      return toResultError(e);
    }
  }

  async list(args: StoreToolArgs): Promise<StoreToolResult> {
    try {
      const uri = String(args.uri ?? '');
      if (!uri) return { ok: false, code: 'bad_op', error: 'uri required' };
      const depthRaw = args.depth;
      const depth =
        depthRaw === undefined || depthRaw === null || depthRaw === ''
          ? 1
          : Number(depthRaw);
      const qs = new URLSearchParams({ uri });
      if (Number.isFinite(depth)) qs.set('depth', String(depth));
      return {
        ok: true,
        data: await this.json(`/api/v1/list?${qs.toString()}`),
      };
    } catch (e) {
      return toResultError(e);
    }
  }
}

export function executeStoreTool(
  name: string,
  args: StoreToolArgs,
  client: StoreToolsClient,
): Promise<StoreToolResult> {
  switch (name) {
    case 'store_write':
      return client.write(args);
    case 'store_read':
      return client.read(args);
    case 'store_meta':
      return client.meta(args);
    case 'store_list':
      return client.list(args);
    default:
      return Promise.resolve({ ok: false, code: 'bad_op', error: `unknown tool: ${name}` });
  }
}

export class StoreToolsError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function toResultError(e: unknown): StoreToolResult {
  if (e instanceof StoreToolsError) {
    return { ok: false, code: e.code, error: e.message };
  }
  return { ok: false, code: 'internal', error: e instanceof Error ? e.message : String(e) };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
