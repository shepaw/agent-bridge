/**
 * ACP RPC calls to a running instance gateway (sessions list / history).
 *
 * Reuses one PeerAcpClient per instance across Dashboard REST requests and
 * closes idle connections after a grace period, avoiding a full WS handshake
 * on every poll.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';

import { loadOrCreateIdentity } from 'shepaw-acp-sdk';
import type { SessionHistoryMessage, SessionInfo } from 'shepaw-acp-sdk';

import type { InstanceConfig } from './config.js';
import { getInstance, loadOrCreateHubConfig, updateInstance } from './config.js';
import { catalogModesWire, parseSessionMode } from './engine-modes.js';
import { instancePaths } from './paths.js';
import { authorizePeerServiceOnInstance } from './peer/peer-auth.js';
import { loadOrCreatePeerIdentity } from './peer/peer-identity.js';
import { createChatStreamAccumulator, type ChatStreamSection } from './chat-stream-split.js';
import { PeerAcpClient, type ApprovalRequest } from './peer/peer-acp-client.js';
import { probeInstanceRuntime } from './runtime-status.js';
import { getPeerLocalStore } from './peer/peer-local-store.js';
import { parseStoreUri } from './peer/peer-store-protocol.js';

/** Close pooled WS when unused for this long (Dashboard polls every 30s). */
const IDLE_CLOSE_MS = 120_000;

export class InstanceGatewayOfflineError extends Error {
  constructor(
    readonly instanceId: string,
    detail?: string,
  ) {
    super(detail ?? `Instance "${instanceId}" gateway is not online.`);
    this.name = 'InstanceGatewayOfflineError';
  }
}

interface PoolEntry {
  client: PeerAcpClient;
  refs: number;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
}

const pool = new Map<string, PoolEntry>();
const creating = new Map<string, Promise<PoolEntry>>();

export interface InstanceAgentCard {
  readonly name: string;
  readonly description: string;
  readonly bio?: string;
  readonly version: string;
  readonly capabilities: string[];
}

/** The card is static per gateway process — a short TTL avoids a WS round-trip
 * on every 3s detail-page poll. */
const CARD_CACHE_TTL_MS = 30_000;
const cardCache = new Map<string, { at: number; card: InstanceAgentCard | null }>();

function parseAgentCard(raw: unknown): InstanceAgentCard | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.description !== 'string' || obj.description.length === 0) return null;
  return {
    name: typeof obj.name === 'string' ? obj.name : '',
    description: obj.description,
    bio: typeof obj.bio === 'string' ? obj.bio : undefined,
    version: typeof obj.version === 'string' ? obj.version : '1.0.0',
    capabilities: Array.isArray(obj.capabilities)
      ? obj.capabilities.filter((c): c is string => typeof c === 'string')
      : [],
  };
}

function parseSessionInfo(raw: unknown): SessionInfo | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const session_id = typeof obj.session_id === 'string' ? obj.session_id : undefined;
  if (session_id === undefined || session_id.length === 0) return null;
  return {
    session_id,
    title: typeof obj.title === 'string' ? obj.title : undefined,
    updated_at: typeof obj.updated_at === 'string' ? obj.updated_at : undefined,
    cwd: typeof obj.cwd === 'string' ? obj.cwd : undefined,
  };
}

export function parseHistoryMessage(raw: unknown): SessionHistoryMessage | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const role = obj.role === 'user' || obj.role === 'agent' ? obj.role : undefined;
  if (role === undefined) return null;
  const content = typeof obj.content === 'string' ? obj.content : '';
  const progress =
    typeof obj.progress_content === 'string' && obj.progress_content.length > 0
      ? obj.progress_content
      : undefined;
  if (content.length === 0 && progress === undefined) return null;
  return {
    role,
    content,
    message_id: typeof obj.message_id === 'string' ? obj.message_id : undefined,
    created_at: typeof obj.created_at === 'string' ? obj.created_at : undefined,
    ...(progress !== undefined ? { progress_content: progress } : {}),
    ...(typeof obj.progress_title === 'string' && obj.progress_title.length > 0
      ? { progress_title: obj.progress_title }
      : {}),
    ...(typeof obj.progress_auto_collapse === 'boolean'
      ? { progress_auto_collapse: obj.progress_auto_collapse }
      : {}),
  };
}

async function ensureGatewayOnline(instanceId: string, instance: InstanceConfig): Promise<void> {
  const runtime = await probeInstanceRuntime(instance);
  if (runtime.availability !== 'online' && runtime.availability !== 'degraded') {
    closeInstanceAcpRpcClient(instanceId);
    throw new InstanceGatewayOfflineError(
      instanceId,
      runtime.probeError ?? `Gateway is ${runtime.availability}. Start the instance to view sessions.`,
    );
  }
}

function scheduleIdleClose(instanceId: string, entry: PoolEntry): void {
  if (entry.refs > 0) return;
  entry.idleTimer = setTimeout(() => {
    if (pool.get(instanceId) === entry) {
      closeInstanceAcpRpcClient(instanceId);
    }
  }, IDLE_CLOSE_MS);
}

async function createPoolEntry(instanceId: string): Promise<PoolEntry> {
  const cfg = loadOrCreateHubConfig();
  const instance = getInstance(cfg, instanceId);
  await ensureGatewayOnline(instanceId, instance);
  authorizePeerServiceOnInstance(instanceId, cfg);

  const peerIdentity = loadOrCreatePeerIdentity();
  const instanceIdentity = loadOrCreateIdentity({ path: instancePaths(instance.id).identityPath });
  const client = new PeerAcpClient(peerIdentity, instance, instanceIdentity, () => {});
  const entry: PoolEntry = { client, refs: 0, idleTimer: undefined };
  pool.set(instanceId, entry);
  return entry;
}

async function acquirePoolEntry(instanceId: string): Promise<PoolEntry> {
  const existing = pool.get(instanceId);
  if (existing !== undefined) {
    if (existing.idleTimer !== undefined) {
      clearTimeout(existing.idleTimer);
      existing.idleTimer = undefined;
    }
    return existing;
  }

  let pending = creating.get(instanceId);
  if (pending === undefined) {
    pending = createPoolEntry(instanceId).finally(() => {
      creating.delete(instanceId);
    });
    creating.set(instanceId, pending);
  }
  return pending;
}

/** Drop a pooled client (e.g. when the instance stops). */
export function closeInstanceAcpRpcClient(instanceId: string): void {
  cardCache.delete(instanceId);
  const entry = pool.get(instanceId);
  if (entry === undefined) return;
  if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
  try {
    entry.client.close();
  } catch {
    /* ignore */
  }
  pool.delete(instanceId);
}

async function withAcpClient<T>(
  instanceId: string,
  fn: (client: PeerAcpClient) => Promise<T>,
): Promise<T> {
  const cfg = loadOrCreateHubConfig();
  const instance = getInstance(cfg, instanceId);
  await ensureGatewayOnline(instanceId, instance);

  const entry = await acquirePoolEntry(instanceId);
  entry.refs += 1;
  if (entry.idleTimer !== undefined) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }

  try {
    return await fn(entry.client);
  } catch (err) {
    closeInstanceAcpRpcClient(instanceId);
    throw err;
  } finally {
    entry.refs -= 1;
    if (entry.refs === 0 && pool.get(instanceId) === entry) {
      scheduleIdleClose(instanceId, entry);
    }
  }
}

/** Live session list from `agent.sessions.list` on the instance gateway. */
export async function listInstanceConversations(instanceId: string): Promise<SessionInfo[]> {
  const raw = await withAcpClient(instanceId, (client) => client.sessions());
  return raw.map(parseSessionInfo).filter((session): session is SessionInfo => session !== null);
}

/** Apply a native session mode to a running instance (`agent.modes.setCurrent`). */
export async function applyInstanceSessionMode(
  instanceId: string,
  mode: string,
  sessionId?: string,
): Promise<{ mode: string; display_name?: string } | null> {
  return withAcpClient(instanceId, (client) => client.modesSetCurrent(mode, sessionId));
}

/** One model or session-mode option from ACP / the engine catalog. */
export interface ConversationOption {
  readonly value: string;
  readonly display_name: string;
  readonly description: string;
}

export function parseConversationOption(raw: unknown): ConversationOption | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const value =
    typeof obj.value === 'string' && obj.value.length > 0
      ? obj.value
      : typeof obj.id === 'string' && obj.id.length > 0
        ? obj.id
        : '';
  if (value.length === 0) return null;
  const display =
    typeof obj.display_name === 'string' && obj.display_name.length > 0
      ? obj.display_name
      : typeof obj.name === 'string' && obj.name.length > 0
        ? obj.name
        : value;
  return {
    value,
    display_name: display,
    description: typeof obj.description === 'string' ? obj.description : '',
  };
}

export function parseConversationOptions(raw: unknown): ConversationOption[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(parseConversationOption)
    .filter((item): item is ConversationOption => item !== null);
}

/** Prefer live ACP modes; fall back to the engine catalog like the App picker. */
export function mergeConversationModes(
  live: { modes: unknown[]; current?: string },
  fallback: { modes: ConversationOption[]; current?: string },
): { modes: ConversationOption[]; current?: string } {
  const modes = parseConversationOptions(live.modes);
  if (modes.length === 0) return fallback;
  return {
    modes,
    current: typeof live.current === 'string' && live.current.length > 0
      ? live.current
      : fallback.current,
  };
}

function persistInstanceSessionMode(instanceId: string, mode: string): void {
  try {
    const cfg = loadOrCreateHubConfig();
    const instance = getInstance(cfg, instanceId);
    const parsed = parseSessionMode(instance.engine, mode, { allowUnknown: true });
    if (parsed === undefined || parsed === instance.sessionMode) return;
    updateInstance(cfg, instanceId, { sessionMode: parsed, allowUnknownSessionMode: true });
  } catch (err) {
    console.warn(
      `[shepaw-hub] failed to persist sessionMode for ${instanceId}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

function catalogFallbackModes(instanceId: string): {
  modes: ConversationOption[];
  current?: string;
} {
  const cfg = loadOrCreateHubConfig();
  const instance = getInstance(cfg, instanceId);
  const wire = catalogModesWire(instance.engine, instance.sessionMode);
  return {
    modes: wire.modes,
    ...(wire.current !== undefined ? { current: wire.current } : {}),
  };
}

/** Live models from `agent.models.list` (same relay the App uses). */
export async function listInstanceConversationModels(
  instanceId: string,
  sessionId?: string,
): Promise<{ models: ConversationOption[]; current?: string }> {
  const live = await withAcpClient(instanceId, (client) => client.modelsList(sessionId));
  return {
    models: parseConversationOptions(live.models),
    ...(typeof live.current === 'string' && live.current.length > 0
      ? { current: live.current }
      : {}),
  };
}

/** Switch the upstream model via `agent.models.setCurrent`. */
export async function setInstanceConversationModel(
  instanceId: string,
  model: string,
  sessionId?: string,
): Promise<{ model: string; display_name?: string }> {
  const trimmed = model.trim();
  if (trimmed.length === 0) throw new Error('model must not be empty');
  const result = await withAcpClient(instanceId, (client) =>
    client.modelsSetCurrent(trimmed, sessionId),
  );
  if (result === null) throw new Error('failed to set model');
  return result;
}

/** Live modes from `agent.modes.list`, with the engine catalog as App-style fallback. */
export async function listInstanceConversationModes(
  instanceId: string,
  sessionId?: string,
): Promise<{ modes: ConversationOption[]; current?: string }> {
  const fallback = catalogFallbackModes(instanceId);
  const live = await withAcpClient(instanceId, (client) => client.modesList(sessionId));
  return mergeConversationModes(live, fallback);
}

/**
 * Switch the upstream session mode via `agent.modes.setCurrent`.
 * Persists the choice on the instance (same as the App) so a restart keeps it.
 */
export async function setInstanceConversationMode(
  instanceId: string,
  mode: string,
  sessionId?: string,
): Promise<{ mode: string; display_name?: string }> {
  const trimmed = mode.trim();
  if (trimmed.length === 0) throw new Error('mode must not be empty');
  const result = await withAcpClient(instanceId, (client) =>
    client.modesSetCurrent(trimmed, sessionId),
  );
  if (result !== null) {
    persistInstanceSessionMode(instanceId, result.mode);
    return result;
  }
  persistInstanceSessionMode(instanceId, trimmed);
  const fallback = catalogFallbackModes(instanceId);
  return {
    mode: trimmed,
    display_name: fallback.modes.find((item) => item.value === trimmed)?.display_name,
  };
}

/** Noise + JSON-RPC smoke test: open a WS and call `agent.sessions.list`. */
export async function pingInstanceAcpRpc(instanceId: string): Promise<{ sessionCount: number }> {
  const sessions = await withAcpClient(instanceId, (client) => client.sessions());
  return { sessionCount: sessions.length };
}

/**
 * Fetch the agent's self-description card (`agent.getCard`) — the workspace
 * resume in `description`/`bio` plus `capabilities`. Returns `null` when the
 * gateway is offline or the card can't be read, so detail pages degrade
 * gracefully. Cached briefly (the card is static per process lifetime).
 */
export async function getInstanceAgentCard(instanceId: string): Promise<InstanceAgentCard | null> {
  const cached = cardCache.get(instanceId);
  if (cached !== undefined && Date.now() - cached.at < CARD_CACHE_TTL_MS) return cached.card;
  let card: InstanceAgentCard | null = null;
  try {
    card = parseAgentCard(await withAcpClient(instanceId, (client) => client.card()));
  } catch {
    card = null;
  }
  cardCache.set(instanceId, { at: Date.now(), card });
  return card;
}

/**
 * Ask the running gateway to re-derive its workspace resume (`agent.resume.rebuild`)
 * and refresh the cached card immediately. Returns `null` when the gateway is
 * offline or the agent doesn't support re-derivation.
 */
export async function rebuildInstanceResume(
  instanceId: string,
  prompt?: string,
): Promise<InstanceAgentCard | null> {
  try {
    const card = parseAgentCard(
      await withAcpClient(instanceId, (client) => client.resumeRebuild(prompt !== undefined ? { prompt } : undefined)),
    );
    if (card !== null) cardCache.set(instanceId, { at: Date.now(), card });
    return card;
  } catch {
    cardCache.delete(instanceId);
    return null;
  }
}

/**
 * Live-apply a custom resume prompt to a running gateway
 * (`agent.resume.promptSet`) without rebuilding. Best-effort: returns the
 * fresh card, or `null` when the gateway is offline / the binary predates
 * the method (the spawn-time env fallback still applies next start).
 */
export async function setInstanceResumePrompt(
  instanceId: string,
  prompt: string,
): Promise<InstanceAgentCard | null> {
  try {
    return parseAgentCard(await withAcpClient(instanceId, (client) => client.resumePromptSet(prompt)));
  } catch {
    return null;
  }
}

export interface InstanceChatTestResult {
  readonly ok: boolean;
  readonly reply: string;
  readonly error: string | null;
  readonly elapsedMs: number;
}

export interface InstanceConversationTurnResult {
  readonly sessionId: string;
  readonly reply: string;
  readonly elapsedMs: number;
  readonly progressContent?: string;
  readonly progressTitle?: string;
  readonly progressAutoCollapse?: boolean;
}

const DASHBOARD_CHAT_MAX_CHARS = 32_000;
const DASHBOARD_CHAT_MAX_ATTACHMENTS = 8;

export interface DashboardChatAttachment {
  readonly uri: string;
  readonly name: string;
}

export function basenameFromStoreUri(uri: string): string {
  const trimmed = uri.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

export function normalizeDashboardChatAttachments(raw: unknown): DashboardChatAttachment[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error('attachments must be an array');
  }
  if (raw.length > DASHBOARD_CHAT_MAX_ATTACHMENTS) {
    throw new Error(`too many attachments (max ${DASHBOARD_CHAT_MAX_ATTACHMENTS})`);
  }
  const out: DashboardChatAttachment[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const uri = item.trim();
      if (!uri.startsWith('store://')) {
        throw new Error('attachment uri must be store://');
      }
      if (!parseStoreUri(uri)) {
        throw new Error(`invalid store uri: ${uri}`);
      }
      out.push({ uri, name: basenameFromStoreUri(uri) });
      continue;
    }
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('attachment must be a store:// uri or { uri, name? }');
    }
    const map = item as Record<string, unknown>;
    const uri = typeof map.uri === 'string' ? map.uri.trim() : '';
    if (!uri.startsWith('store://')) {
      throw new Error('attachment uri must be store://');
    }
    if (!parseStoreUri(uri)) {
      throw new Error(`invalid store uri: ${uri}`);
    }
    const name =
      typeof map.name === 'string' && map.name.trim().length > 0
        ? map.name.trim()
        : basenameFromStoreUri(uri);
    out.push({ uri, name });
  }
  return out;
}

export function formatDashboardChatAttachments(refs: readonly DashboardChatAttachment[]): string {
  if (refs.length === 0) return '';
  return `Pouch attachments:\n${refs.map((ref) => `- [${ref.name}](${ref.uri})`).join('\n')}`;
}

export function composeDashboardChatMessage(
  message: unknown,
  attachments?: unknown,
): { text: string; attachments: DashboardChatAttachment[] } {
  const refs = normalizeDashboardChatAttachments(attachments);
  if (message !== undefined && message !== null && typeof message !== 'string' && refs.length === 0) {
    throw new Error('message must be a string');
  }
  const trimmed = typeof message === 'string' ? message.trim() : '';
  if (trimmed.length > DASHBOARD_CHAT_MAX_CHARS) {
    throw new Error(`message exceeds ${DASHBOARD_CHAT_MAX_CHARS} characters`);
  }
  if (trimmed.length === 0 && refs.length === 0) {
    throw new Error('message must not be empty');
  }
  const formatted = formatDashboardChatAttachments(refs);
  return {
    text: formatted.length > 0 ? (trimmed.length > 0 ? `${trimmed}\n\n${formatted}` : formatted) : trimmed,
    attachments: refs,
  };
}

function guessMime(name: string): string {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  switch (ext) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'pdf': return 'application/pdf';
    case 'json': return 'application/json';
    case 'md':
    case 'markdown': return 'text/markdown';
    case 'txt':
    case 'log':
    case 'csv': return 'text/plain';
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs': return 'text/plain';
    default: return 'application/octet-stream';
  }
}

function resolveDashboardStoreAttachments(
  refs: readonly DashboardChatAttachment[],
): Record<string, unknown>[] | undefined {
  if (refs.length === 0) return undefined;
  const store = getPeerLocalStore();
  const out: Record<string, unknown>[] = [];
  for (const ref of refs) {
    const parsed = parseStoreUri(ref.uri);
    if (!parsed || parsed.path.length === 0) {
      throw new Error(`invalid store file uri: ${ref.uri}`);
    }
    const abs = store.absPath(parsed.device, parsed.space, parsed.path);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      throw new Error(`attachment not found in pouch: ${ref.uri}`);
    }
    const st = statSync(abs);
    const mime = guessMime(ref.name);
    out.push({
      file_id: ref.uri,
      file_name: ref.name,
      mime_type: mime,
      size: st.size,
      type: mime.startsWith('image/') ? 'image' : 'file',
      path: abs,
    });
  }
  return out;
}

/** Hub-dashboard / test chats auto-allow tools so the operator is not blocked. */
function autoApproveTool(req: ApprovalRequest): { id: string; label?: string } {
  const allow =
    req.actions.find((a) => a.id === 'allow') ??
    req.actions.find((a) => a.id === 'allow-all') ??
    req.actions.find((a) => a.id !== 'deny') ??
    req.actions[0];
  if (allow === undefined) {
    throw new Error('approval requested but agent offered no actions');
  }
  return { id: allow.id, label: allow.label ?? 'Allow (hub dashboard)' };
}

function awaitChatReply(
  client: PeerAcpClient,
  opts: {
    message: string;
    sessionId: string;
    timeoutMs: number;
    attachments?: ReadonlyArray<Record<string, unknown>>;
  },
): Promise<ChatStreamSection> {
  const taskId = randomUUID();
  const stream = createChatStreamAccumulator();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        client.cancelTurn(taskId);
        reject(new Error(`chat timed out after ${opts.timeoutMs}ms`));
      });
    }, opts.timeoutMs);

    void client
      .chat(
        {
          message: opts.message,
          taskId,
          sessionId: opts.sessionId,
          attachments: opts.attachments,
        },
        {
          onChunk: (content) => {
            stream.onChunk(content);
          },
          onMetadata: (meta) => {
            stream.onMetadata(meta);
          },
          onDone: () => {
            finish(() => resolve(stream.result()));
          },
          onError: (messageText) => {
            finish(() => reject(new Error(messageText)));
          },
          onApproval: async (req) => autoApproveTool(req),
        },
      )
      .catch((err: unknown) => {
        finish(() => reject(err instanceof Error ? err : new Error(String(err))));
      });
  });
}

export function normalizeDashboardChatMessage(message: unknown): string {
  if (typeof message !== 'string') {
    throw new Error('message must be a string');
  }
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    throw new Error('message must not be empty');
  }
  if (trimmed.length > DASHBOARD_CHAT_MAX_CHARS) {
    throw new Error(`message exceeds ${DASHBOARD_CHAT_MAX_CHARS} characters`);
  }
  return trimmed;
}

export function resolveDashboardChatSessionId(sessionId?: string): string {
  const trimmed = sessionId?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : `hub-dash_${randomUUID()}`;
}

/**
 * End-to-end chat probe: Noise handshake → `agent.chat` → first completion.
 * Auto-approves tool-call confirmations so unattended CI / doctor flows work.
 */
export async function chatInstanceAcpRpc(
  instanceId: string,
  message: string,
  opts: { timeoutMs?: number; sessionPrefix?: string } = {},
): Promise<InstanceChatTestResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const started = Date.now();
  const sessionId = `${opts.sessionPrefix ?? 'hub-test'}_${randomUUID()}`;

  try {
    const section = await withAcpClient(instanceId, (client) =>
      awaitChatReply(client, { message, sessionId, timeoutMs }),
    );
    return {
      ok: true,
      reply: section.reply.length > 0 ? section.reply : (section.progressContent ?? ''),
      error: null,
      elapsedMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      reply: '',
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: Date.now() - started,
    };
  } finally {
    closeInstanceAcpRpcClient(instanceId);
  }
}

/**
 * Dashboard conversation turn. Reuses the pooled ACP client so a follow-up
 * message in the same session keeps the live binding. Auto-approves tools.
 */
export async function chatInstanceConversation(
  instanceId: string,
  message: unknown,
  opts: { sessionId?: string; timeoutMs?: number; attachments?: unknown } = {},
): Promise<InstanceConversationTurnResult> {
  const composed = composeDashboardChatMessage(message, opts.attachments);
  const acpAttachments = resolveDashboardStoreAttachments(composed.attachments);
  const sessionId = resolveDashboardChatSessionId(opts.sessionId);
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const started = Date.now();
  const section = await withAcpClient(instanceId, (client) =>
    awaitChatReply(client, {
      message: composed.text,
      sessionId,
      timeoutMs,
      attachments: acpAttachments,
    }),
  );
  return {
    sessionId,
    reply: section.reply,
    elapsedMs: Date.now() - started,
    ...(section.progressContent !== undefined
      ? {
          progressContent: section.progressContent,
          progressTitle: section.progressTitle,
          progressAutoCollapse: section.progressAutoCollapse,
        }
      : {}),
  };
}

/** Replayed transcript from `agent.sessions.history`. */
export async function getInstanceConversationHistory(
  instanceId: string,
  sessionId: string,
): Promise<SessionHistoryMessage[]> {
  const raw = await withAcpClient(instanceId, (client) => client.sessionHistory(sessionId));
  return raw.map(parseHistoryMessage).filter((message): message is SessionHistoryMessage => message !== null);
}

// ── resume AI polish ───────────────────────────────────────────────

export interface ResumePolishMessageInput {
  readonly agentId: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly label?: string;
}

/**
 * Compose the single-turn instruction sent to the agent during
 * "AI 润色简历". The agent rewrites the `## Summary` section per the
 * operator's prompt and outputs the new text between resume markers — it
 * does NOT write anything itself. The hub then applies the text via the
 * `agent.resume.summarySet` RPC, so the turn involves no tool calls and
 * therefore no permission approvals (an approval mid-polish previously
 * stalled the turn until the chat timeout).
 */
export function buildResumePolishMessage(input: ResumePolishMessageInput): string {
  return [
    `你是实例「${input.label ?? input.agentId}」(agent_id: ${input.agentId})，工作区是 ${input.cwd}。`,
    '请根据下面的自定义提示词，重写你简历的 `## Summary` 部分（保持基于工作区的真实事实，不要编造项目、技术栈或经历）。',
    '只输出重写后的 Summary 全文，用下面的标记包裹，不要运行任何命令、不要写任何文件：',
    '',
    RESUME_MARK_BEGIN,
    '<重写后的 Summary 全文>',
    RESUME_MARK_END,
    '',
    '【自定义提示词】',
    input.prompt,
  ].join('\n');
}

/** Delimiters around the AI-generated Summary in the polish turn's reply. */
const RESUME_MARK_BEGIN = '<<<RESUME_SUMMARY_BEGIN>>>';
const RESUME_MARK_END = '<<<RESUME_SUMMARY_END>>>';

/** Extract the Summary text between the polish markers from a chat reply. */
export function extractPolishedSummary(reply: string): string | null {
  const begin = reply.indexOf(RESUME_MARK_BEGIN);
  const end = reply.indexOf(RESUME_MARK_END);
  if (begin < 0 || end < 0 || end <= begin) return null;
  const text = reply
    .slice(begin + RESUME_MARK_BEGIN.length, end)
    .trim();
  return text.length > 0 ? text : null;
}

export interface ResumePolishResult {
  readonly ok: boolean;
  readonly summary: string | null;
  readonly capabilities: readonly string[];
  readonly reply: string;
  readonly error: string | null;
  readonly elapsedMs: number;
}

/**
 * AI resume polish: drive one chat turn that makes the agent *draft* a new
 * Summary per the custom prompt, then apply the drafted text via
 * `agent.resume.summarySet`. The write is a direct RPC — no Bash tool call,
 * no permission approval — so the turn can no longer stall on review.
 * Falls back to the legacy chat-driven `agents.resume-set` shim flow when
 * the connected gateway predates `summarySet`.
 */
export async function polishInstanceResume(
  instanceId: string,
  agentId: string,
  prompt: string,
  cwd: string,
  label?: string,
  opts: { timeoutMs?: number } = {},
): Promise<ResumePolishResult> {
  const message = buildResumePolishMessage({ agentId, prompt, cwd, label });
  // A full LLM turn (draft-only, no tool calls) is still slower than the 60s
  // chat probe — give it 3 minutes. The `hub-resume_` prefix keeps these
  // sessions greppable by origin in session lists.
  const chat = await chatInstanceAcpRpc(instanceId, message, {
    timeoutMs: opts.timeoutMs ?? 180_000,
    sessionPrefix: 'hub-resume',
  });
  if (!chat.ok) {
    return { ok: false, summary: null, capabilities: [], reply: chat.reply, error: chat.error, elapsedMs: chat.elapsedMs };
  }

  const polished = extractPolishedSummary(chat.reply);
  if (polished !== null) {
    const applied = await withAcpClient(instanceId, (client) => client.resumeSummarySet(polished));
    if (applied === undefined) {
      return {
        ok: false,
        summary: null,
        capabilities: [],
        reply: chat.reply,
        error: '网关不支持直接写入简历（agent.resume.summarySet），请升级实例网关后重试。',
        elapsedMs: chat.elapsedMs,
      };
    }
  }
  // summarySet adopts the text inside the gateway; the card cache may predate
  // it, so drop it and pull fresh. (Legacy shim flow adopted at turn end.)
  invalidateInstanceCardCache(instanceId);
  const card = await getInstanceAgentCard(instanceId);
  return {
    ok: true,
    summary: card?.description ?? null,
    capabilities: card?.capabilities ?? [],
    reply: chat.reply,
    error: null,
    elapsedMs: chat.elapsedMs,
  };
}

/** Drop the cached agent card for an instance (next read re-pulls). */
export function invalidateInstanceCardCache(instanceId: string): void {
  cardCache.delete(instanceId);
}
