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
 */

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
      '(store://<space>/<device>/<path>). Local-first; when a master is set, mirrored over the peer channel.',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Relative path (no leading /, no ..)' },
        content: { type: 'string' },
        space: {
          type: 'string',
          enum: ['artifacts', 'files', 'attachments', 'backups', 'memory', 'sessions', 'workspaces', 'agents'],
          default: 'artifacts',
        },
        task: { type: 'string', description: 'Optional task folder prefix' },
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
      'List a directory by store:// URI (store://<space>/<device>/<prefix>). ' +
      'Paired remote devices are readable over the shared peer channel.',
    inputSchema: {
      type: 'object',
      properties: { uri: { type: 'string' } },
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
      const space = String(args.space ?? 'artifacts');
      const task = args.task ? String(args.task) : undefined;
      const path = task ? `${task}/${filename}` : filename;
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
      if (context || toAgent) {
        const handoffPayload: Record<string, unknown> = {
          space,
          upload_ids: [uploadId],
        };
        if (context) handoffPayload.context = context;
        if (toAgent) handoffPayload.to_agent = toAgent;
        const handoff = await this.storeOp('handoff.create', handoffPayload);
        return {
          ok: true,
          data: {
            uri: String(handoff.handoff_uri ?? uri),
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
      return { ok: true, data: { uri, space, path, size: bytes.length, sha256: sha } };
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
      return { ok: true, data: await this.json(`/api/v1/list?uri=${encodeURIComponent(uri)}`) };
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

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
