/**
 * NDJSON interceptor between zcode-acp-server and zcode.cjs.
 *
 * Answers server→client requests the adapter does not implement, and overlays
 * a headless-friendly runtimeModel so Coding Plan OAuth/captcha is not used
 * when a regular API-key provider exists. GLM-5.3 rejects disabled thinking
 * (provider code 1210), so we also force thoughtLevel=low after create/resume.
 */

import { replyForZcodeServerRequest } from './zcode-runtime-preferences.js';
import type { ZcodeDesktopCredentials } from './zcode-desktop-credentials.js';

export const ZCODE_UPDATE_RUNTIME_MODEL_METHOD = 'session/updateRuntimeModelConfig';
export const ZCODE_SET_THOUGHT_LEVEL_METHOD = 'session/setThoughtLevel';
export const ZCODE_SET_MODEL_METHOD = 'session/setModel';
export const ZCODE_HEADLESS_THOUGHT_LEVEL = 'low';

interface JsonRpcMsg {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export function buildZcodeRuntimeModel(
  creds: ZcodeDesktopCredentials,
  now: number = Date.now(),
): Record<string, unknown> {
  return {
    revision: 'shepaw-hub',
    generatedAt: now,
    model: {
      providerId: creds.providerId,
      modelId: creds.modelId,
      ...(creds.modelVariant !== undefined ? { variant: creds.modelVariant } : {}),
    },
    provider: {
      providerId: creds.providerId,
      kind: creds.kind,
      apiFormat: creds.kind === 'anthropic' ? 'anthropic-messages' : 'openai-chat-completions',
      source: 'workspace',
      ...(creds.ZCODE_BASE_URL.length > 0 ? { baseURL: creds.ZCODE_BASE_URL } : {}),
      apiKey: { source: 'env', name: 'ANTHROPIC_API_KEY' },
      models:
        creds.modelCatalog.length > 0
          ? creds.modelCatalog
          : creds.models.map((modelId) => ({ modelId })),
    },
    thoughtLevel: creds.modelVariant ?? ZCODE_HEADLESS_THOUGHT_LEVEL,
  };
}

function parseRpc(line: string): JsonRpcMsg | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    return JSON.parse(trimmed) as JsonRpcMsg;
  } catch {
    return null;
  }
}

function sessionIdFromCreateResult(result: unknown): string | null {
  if (result === null || typeof result !== 'object') return null;
  const rec = result as {
    sessionId?: unknown;
    session?: { sessionId?: unknown };
    projection?: { sessionId?: unknown };
  };
  for (const sid of [rec.sessionId, rec.session?.sessionId, rec.projection?.sessionId]) {
    if (typeof sid === 'string' && sid.length > 0) return sid;
  }
  return null;
}

function rpcRequest(id: string, method: string, params: Record<string, unknown>): string {
  // zcode.cjs Zod schemas are `.strict()` and reject a `jsonrpc` envelope key.
  return JSON.stringify({ id, method, params });
}

export interface InterceptorOutbound {
  readonly forward?: string;
  readonly toChild?: string;
  readonly holdCreate?: boolean;
}

export class ZcodeStdioInterceptor {
  private readonly createIds = new Set<string | number>();
  private readonly resumeSessionById = new Map<string | number, string>();
  private heldLine: string | null = null;
  private followUps: string[] = [];
  private currentFollowUpId: string | null = null;
  private seq = 0;

  constructor(private readonly creds: ZcodeDesktopCredentials | null) {}

  inbound(line: string): string {
    const msg = parseRpc(line);
    if (msg === null) return line;
    if (msg.method === 'session/create' && (typeof msg.id === 'string' || typeof msg.id === 'number')) {
      this.createIds.add(msg.id);
    }
    if (
      (msg.method === 'session/resume' || msg.method === 'session/load') &&
      (typeof msg.id === 'string' || typeof msg.id === 'number') &&
      msg.params !== null &&
      typeof msg.params === 'object'
    ) {
      const sid = (msg.params as { sessionId?: unknown }).sessionId;
      if (typeof sid === 'string' && sid.length > 0) this.resumeSessionById.set(msg.id, sid);
    }
    if (
      this.creds !== null &&
      (msg.method === 'session/resume' || msg.method === 'session/load') &&
      msg.params !== null &&
      typeof msg.params === 'object'
    ) {
      return JSON.stringify({
        ...msg,
        params: {
          ...(msg.params as Record<string, unknown>),
          runtimeModel: buildZcodeRuntimeModel(this.creds),
        },
      });
    }
    return line;
  }

  outbound(line: string): InterceptorOutbound {
    const auto = replyForZcodeServerRequest(line);
    if (auto !== null) return { toChild: auto };

    const msg = parseRpc(line);
    if (msg === null) return { forward: line };

    if (this.currentFollowUpId !== null && msg.id === this.currentFollowUpId) {
      return this.nextFollowUpOrRelease();
    }

    if (typeof msg.id !== 'string' && typeof msg.id !== 'number') {
      return { forward: line };
    }

    if (this.creds !== null && this.createIds.has(msg.id)) {
      this.createIds.delete(msg.id);
      if (msg.error !== undefined) return { forward: line };
      const sessionId = sessionIdFromCreateResult(msg.result);
      if (sessionId === null) return { forward: line };
      return this.beginFollowUps(line, sessionId);
    }

    if (this.creds !== null && this.resumeSessionById.has(msg.id)) {
      const sessionId = this.resumeSessionById.get(msg.id)!;
      this.resumeSessionById.delete(msg.id);
      if (msg.error !== undefined) return { forward: line };
      return this.beginFollowUps(line, sessionId);
    }

    return { forward: line };
  }

  flushHeldCreate(): string | null {
    const held = this.heldLine;
    this.heldLine = null;
    this.followUps = [];
    this.currentFollowUpId = null;
    return held;
  }

  isHoldingCreate(): boolean {
    return this.heldLine !== null;
  }

  private beginFollowUps(heldLine: string, sessionId: string): InterceptorOutbound {
    this.heldLine = heldLine;
    const runtimeModel = buildZcodeRuntimeModel(this.creds!);
    const model = (runtimeModel.model ?? {}) as Record<string, unknown>;
    this.followUps = [
      rpcRequest(`shepaw-rm-${++this.seq}`, ZCODE_UPDATE_RUNTIME_MODEL_METHOD, {
        sessionId,
        applyModelSelection: true,
        runtimeModel,
      }),
      rpcRequest(`shepaw-sm-${++this.seq}`, ZCODE_SET_MODEL_METHOD, {
        sessionId,
        model,
        persistAsWorkspaceLastUsed: false,
      }),
      rpcRequest(`shepaw-tl-${++this.seq}`, ZCODE_SET_THOUGHT_LEVEL_METHOD, {
        sessionId,
        thoughtLevel: ZCODE_HEADLESS_THOUGHT_LEVEL,
      }),
    ];
    return { holdCreate: true, toChild: this.takeFollowUp() };
  }

  private nextFollowUpOrRelease(): InterceptorOutbound {
    if (this.followUps.length > 0) {
      return { toChild: this.takeFollowUp() };
    }
    const held = this.heldLine;
    this.heldLine = null;
    this.currentFollowUpId = null;
    return held !== null ? { forward: held } : {};
  }

  private takeFollowUp(): string {
    const line = this.followUps.shift()!;
    const msg = parseRpc(line);
    this.currentFollowUpId = typeof msg?.id === 'string' ? msg.id : null;
    return line;
  }
}
