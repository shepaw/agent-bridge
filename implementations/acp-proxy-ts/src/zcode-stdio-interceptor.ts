/**
 * NDJSON interceptor between zcode-acp-server and zcode.cjs.
 *
 * Answers server→client requests the adapter does not implement, overlays a
 * headless-friendly runtimeModel (API key, catalog), and remembers the model
 * the Shepaw app selected so create/resume do not pin GLM-5.2 forever.
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

function variantForModel(creds: ZcodeDesktopCredentials, modelId: string): string | undefined {
  if (modelId === creds.modelId) return creds.modelVariant;
  const entry = creds.modelCatalog.find((item) => item.modelId === modelId);
  const levels = entry?.reasoning?.levels.map((level) => level.value) ?? [];
  if (levels.includes('low')) return 'low';
  return entry?.reasoning?.defaultLevel;
}

export function buildZcodeRuntimeModel(
  creds: ZcodeDesktopCredentials,
  opts: { modelId?: string; now?: number } = {},
): Record<string, unknown> {
  const modelId = opts.modelId ?? creds.modelId;
  const variant = variantForModel(creds, modelId);
  return {
    revision: 'shepaw-hub',
    generatedAt: opts.now ?? Date.now(),
    model: {
      providerId: creds.providerId,
      modelId,
      ...(variant !== undefined ? { variant } : {}),
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
          : creds.models.map((id) => ({ modelId: id })),
    },
    ...(variant !== undefined ? { thoughtLevel: variant } : {}),
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

function modelIdFromParams(params: unknown): string | undefined {
  if (params === null || typeof params !== 'object') return undefined;
  const rec = params as {
    modelId?: unknown;
    model?: unknown;
    runtimeModel?: { model?: { modelId?: unknown } };
  };
  const nested =
    rec.runtimeModel?.model?.modelId ??
    (rec.model !== null && typeof rec.model === 'object'
      ? (rec.model as { modelId?: unknown }).modelId
      : rec.model);
  for (const value of [nested, rec.modelId]) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
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
  private selectedModelId: string | undefined;
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
      (msg.method === ZCODE_UPDATE_RUNTIME_MODEL_METHOD || msg.method === ZCODE_SET_MODEL_METHOD)
    ) {
      const selected = modelIdFromParams(msg.params);
      if (selected !== undefined) this.selectedModelId = selected;
      return this.enrichModelConfig(msg, selected ?? this.selectedModelId);
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
          runtimeModel: this.runtimeModel(),
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

  private runtimeModel(): Record<string, unknown> {
    return buildZcodeRuntimeModel(this.creds!, { modelId: this.selectedModelId });
  }

  private enrichModelConfig(msg: JsonRpcMsg, modelId: string | undefined): string {
    const overlay = this.runtimeModel();
    const params =
      msg.params !== null && typeof msg.params === 'object'
        ? { ...(msg.params as Record<string, unknown>) }
        : {};
    const existing =
      params.runtimeModel !== null && typeof params.runtimeModel === 'object'
        ? (params.runtimeModel as Record<string, unknown>)
        : {};
    const existingModel =
      existing.model !== null && typeof existing.model === 'object'
        ? (existing.model as Record<string, unknown>)
        : {};
    params.runtimeModel = {
      ...overlay,
      ...existing,
      model: {
        ...(overlay.model as Record<string, unknown>),
        ...existingModel,
        ...(modelId !== undefined ? { modelId } : {}),
      },
      provider: overlay.provider,
    };
    if (params.model !== null && typeof params.model === 'object') {
      params.model = {
        ...(params.model as Record<string, unknown>),
        providerId: this.creds!.providerId,
        ...(modelId !== undefined ? { modelId } : {}),
      };
    }
    const rest = { ...msg };
    delete (rest as { jsonrpc?: unknown }).jsonrpc;
    return JSON.stringify({ ...rest, params });
  }

  private beginFollowUps(heldLine: string, sessionId: string): InterceptorOutbound {
    this.heldLine = heldLine;
    const runtimeModel = this.runtimeModel();
    const model = (runtimeModel.model ?? {}) as Record<string, unknown>;
    const variant = variantForModel(this.creds!, String(model.modelId ?? this.creds!.modelId));
    this.followUps = [
      rpcRequest(`shepaw-rm-${++this.seq}`, ZCODE_UPDATE_RUNTIME_MODEL_METHOD, {
        sessionId,
        applyModelSelection: true,
        runtimeModel,
      }),
      rpcRequest(`shepaw-sm-${++this.seq}`, ZCODE_SET_MODEL_METHOD, {
        sessionId,
        model,
        runtimeModel,
        persistAsWorkspaceLastUsed: false,
      }),
      ...(variant !== undefined
        ? [
            rpcRequest(`shepaw-tl-${++this.seq}`, ZCODE_SET_THOUGHT_LEVEL_METHOD, {
              sessionId,
              thoughtLevel: variant,
            }),
          ]
        : []),
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
