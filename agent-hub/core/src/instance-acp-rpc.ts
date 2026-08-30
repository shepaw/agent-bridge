/**
 * ACP RPC calls to a running instance gateway (sessions list / history).
 *
 * Reuses one PeerAcpClient per instance across Dashboard REST requests and
 * closes idle connections after a grace period, avoiding a full WS handshake
 * on every poll.
 */

import { randomUUID } from 'node:crypto';

import { loadOrCreateIdentity } from 'shepaw-acp-sdk';
import type { SessionHistoryMessage, SessionInfo } from 'shepaw-acp-sdk';

import type { InstanceConfig } from './config.js';
import { getInstance, loadOrCreateHubConfig } from './config.js';
import { instancePaths } from './paths.js';
import { authorizePeerServiceOnInstance } from './peer/peer-auth.js';
import { loadOrCreatePeerIdentity } from './peer/peer-identity.js';
import { PeerAcpClient } from './peer/peer-acp-client.js';
import { probeInstanceRuntime } from './runtime-status.js';

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

function parseHistoryMessage(raw: unknown): SessionHistoryMessage | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const role = obj.role === 'user' || obj.role === 'agent' ? obj.role : undefined;
  const content = typeof obj.content === 'string' ? obj.content : undefined;
  if (role === undefined || content === undefined) return null;
  return {
    role,
    content,
    message_id: typeof obj.message_id === 'string' ? obj.message_id : undefined,
    created_at: typeof obj.created_at === 'string' ? obj.created_at : undefined,
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
): Promise<{ mode: string; display_name?: string } | null> {
  return withAcpClient(instanceId, (client) => client.modesSetCurrent(mode));
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
  const taskId = randomUUID();
  const sessionId = `${opts.sessionPrefix ?? 'hub-test'}_${taskId}`;

  try {
    const reply = await withAcpClient(instanceId, async (client) => {
      return await new Promise<string>((resolve, reject) => {
        let settled = false;
        let full = '';
        const finish = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn();
        };
        const timer = setTimeout(() => {
          finish(() => {
            client.cancelTurn(taskId);
            reject(new Error(`chat timed out after ${timeoutMs}ms`));
          });
        }, timeoutMs);

        void client
          .chat(
            { message, taskId, sessionId },
            {
              onChunk: (content) => {
                full += content;
              },
              onDone: (content) => {
                finish(() => resolve(content.length > 0 ? content : full));
              },
              onError: (messageText) => {
                finish(() => reject(new Error(messageText)));
              },
              onApproval: async (req) => {
                const allow =
                  req.actions.find((a) => a.id === 'allow') ??
                  req.actions.find((a) => a.id === 'allow-all') ??
                  req.actions.find((a) => a.id !== 'deny') ??
                  req.actions[0];
                if (allow === undefined) {
                  throw new Error('approval requested but agent offered no actions');
                }
                return { id: allow.id, label: allow.label ?? 'Allow (hub test)' };
              },
            },
          )
          .catch((err: unknown) => {
            finish(() => reject(err instanceof Error ? err : new Error(String(err))));
          });
      });
    });

    return {
      ok: true,
      reply,
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
 * "AI 润色简历". The agent reads its current resume, rewrites only the
 * `## Summary` section per the operator's prompt, and writes it back through
 * the `agents.resume-set` shim — the gateway's turn-end adoption then picks
 * the new text up automatically.
 */
export function buildResumePolishMessage(input: ResumePolishMessageInput): string {
  return [
    `你是实例「${input.label ?? input.agentId}」(agent_id: ${input.agentId})，工作区是 ${input.cwd}。`,
    '请按以下步骤更新你自己的简历（只做这三步，不要做其他任何事）：',
    `1. 运行 \`shepaw context agents.resume-get --id ${input.agentId}\` 读取你当前的简历。`,
    '2. 严格根据下面的自定义提示词，重写简历的 `## Summary` 部分（保持基于工作区的真实事实，不要编造项目、技术栈或经历）。',
    `3. 运行 \`shepaw context agents.resume-set --id ${input.agentId} --text "<重写后的 Summary 全文>"\` 完成写入。`,
    '',
    '【自定义提示词】',
    input.prompt,
    '',
    '完成后只需简短确认你写入的新 Summary 第一行。',
  ].join('\n');
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
 * AI resume polish: drive one chat turn that makes the agent rewrite its own
 * Summary per the custom prompt, then return the adopted card. The gateway
 * adopts the rewritten resume at turn end (before onDone resolves), so the
 * returned card already reflects the AI text.
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
  // A full LLM turn (read + write + confirm) is far slower than the 60s chat
  // probe — give it 3 minutes. The `hub-resume_` prefix keeps these sessions
  // greppable by origin in session lists.
  const chat = await chatInstanceAcpRpc(instanceId, message, {
    timeoutMs: opts.timeoutMs ?? 180_000,
    sessionPrefix: 'hub-resume',
  });
  if (!chat.ok) {
    return { ok: false, summary: null, capabilities: [], reply: chat.reply, error: chat.error, elapsedMs: chat.elapsedMs };
  }
  // The adoption happened inside the gateway during the turn; the card cache
  // may predate it, so drop it and pull fresh.
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
