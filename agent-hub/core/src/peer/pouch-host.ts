/**
 * 储物袋主机上的群编排和惜宝回合。
 *
 * App 把 `pouch_group_turn` / `pouch_dm_turn` 交到这里。工人 Agent 由调用方
 * 拨到对应 Hub；惜宝在这台主机上开口。聊天页用 `pouch_chat_read` 读这里留下的记录。
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { peerStoreRoot } from '../paths.js';
import { hubStoreDeviceId } from './agent-store-mapping.js';

export const SHE_AGENT_ID = 'she-builtin-agent-001';
export const SHE_AGENT_NAME = '惜宝';

export const POUCH_GROUP_TURN = 'pouch_group_turn';
export const POUCH_DM_TURN = 'pouch_dm_turn';
export const POUCH_CHAT_READ = 'pouch_chat_read';
export const POUCH_INTERACTION_RESP = 'pouch_interaction_resp';
export const POUCH_TURN_EVENT = 'pouch_turn_event';

export interface GroupMember {
  readonly id: string;
  readonly name: string;
}

export interface PouchMessage {
  readonly id: string;
  readonly channel_id: string;
  readonly type: string;
  readonly content: string;
  readonly timestamp: number;
  readonly from: { readonly id: string; readonly type: string; readonly name: string };
  readonly metadata: Record<string, unknown>;
}

function channelFileName(channelId: string): string {
  const cleaned = channelId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return `${cleaned.length > 0 ? cleaned : 'channel'}.json`;
}

export class PouchChatLog {
  private readonly channels = new Map<string, PouchMessage[]>();
  private readonly loaded = new Set<string>();

  constructor(private readonly dir?: string | (() => string | undefined)) {}

  private directory(): string | undefined {
    const value = typeof this.dir === 'function' ? this.dir() : this.dir;
    return value && value.length > 0 ? value : undefined;
  }

  private ensure(channelId: string): void {
    if (this.loaded.has(channelId)) return;
    this.loaded.add(channelId);
    const dir = this.directory();
    if (!dir) return;
    const file = join(dir, channelFileName(channelId));
    if (!existsSync(file)) return;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      if (Array.isArray(parsed)) {
        this.channels.set(channelId, parsed as PouchMessage[]);
      }
    } catch {
      /* a torn file must not drop the live turn */
    }
  }

  private flush(channelId: string): void {
    const dir = this.directory();
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, channelFileName(channelId));
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.channels.get(channelId) ?? []), 'utf8');
      renameSync(tmp, file);
    } catch {
      /* chat still lives in memory for this process */
    }
  }

  append(message: PouchMessage): void {
    this.ensure(message.channel_id);
    const list = this.channels.get(message.channel_id) ?? [];
    list.push(message);
    this.channels.set(message.channel_id, list);
    this.flush(message.channel_id);
  }

  all(channelId: string): readonly PouchMessage[] {
    this.ensure(channelId);
    return this.channels.get(channelId) ?? [];
  }

  count(channelId: string): number {
    return this.all(channelId).length;
  }

  latest(channelId: string, limit: number): PouchMessage[] {
    const all = this.all(channelId);
    return all.slice(Math.max(0, all.length - limit));
  }

  older(channelId: string, beforeTimestamp: number, limit: number): PouchMessage[] {
    const older = this.all(channelId).filter((m) => m.timestamp < beforeTimestamp);
    return older.slice(Math.max(0, older.length - limit));
  }

  including(channelId: string, messageId: string, paddingAfter: number): PouchMessage[] {
    const all = this.all(channelId);
    const index = all.findIndex((m) => m.id === messageId);
    if (index < 0) return [];
    return all.slice(index, index + 1 + paddingAfter);
  }

  one(channelId: string, messageId: string): PouchMessage[] {
    const found = this.all(channelId).find((m) => m.id === messageId);
    return found === undefined ? [] : [found];
  }
}

/** Chat log for the live peer process. Files sit in the host pouch. */
export const hubPouchChat = new PouchChatLog(() => {
  try {
    return join(peerStoreRoot(), hubStoreDeviceId(), 'sessions', 'channels');
  } catch {
    return undefined;
  }
});

/** 管理员在、且用户没有点名时，先只让管理员说。否则点名的人说；都没点名就全员。 */
export function firstRound(input: {
  members: readonly GroupMember[];
  mentionedIds: readonly string[];
  adminId?: string;
}): GroupMember[] {
  const byId = new Map(input.members.map((m) => [m.id, m]));
  const mentioned = input.mentionedIds
    .map((id) => byId.get(id))
    .filter((m): m is GroupMember => m !== undefined);
  if (mentioned.length > 0) return mentioned;
  const admin = input.adminId ? byId.get(input.adminId) : undefined;
  if (admin !== undefined) return [admin];
  return [...input.members];
}

/** 从管理员回复里认出 @成员。同一个 @ 只取最长的名字。 */
export function membersMentionedIn(
  text: string,
  members: readonly GroupMember[],
): GroupMember[] {
  const ranked = [...members]
    .filter((m) => m.name.trim().length > 0)
    .sort((a, b) => b.name.length - a.name.length);
  const found: GroupMember[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '@') continue;
    const rest = text.slice(i + 1);
    const hit = ranked.find((m) => rest.startsWith(m.name.trim()));
    if (hit === undefined || seen.has(hit.id)) continue;
    seen.add(hit.id);
    found.push(hit);
    i += hit.name.trim().length;
  }
  return found;
}

export interface SpeakRequest {
  readonly agentId: string;
  readonly agentName: string;
  readonly content: string;
  readonly channelId: string;
  readonly onChunk: (chunk: string) => void;
  readonly groupId?: string;
  readonly sessionId?: string;
  readonly members?: readonly GroupMember[];
}

export interface OrchestrationInbox {
  readonly finish?: 'done' | 'continue' | 'pause';
  readonly mode?: 'concurrent' | 'sequential';
  readonly steps?: ReadonlyArray<{
    readonly agents: readonly string[];
    readonly task: string;
    readonly step?: number;
  }>;
  readonly mentions?: ReadonlyArray<{
    readonly name: string;
    readonly notify?: boolean;
    readonly reason?: string;
  }>;
}

export interface InboxQuery {
  readonly groupId: string;
  readonly sessionId: string;
  readonly sinceMs: number;
}

export interface FollowTurn {
  readonly member: GroupMember;
  readonly prompt: string;
  readonly concurrent: boolean;
}

export type MemberSpeaker = (req: SpeakRequest) => Promise<string>;

export interface PouchTurnDeps {
  readonly speak: MemberSpeaker;
  readonly log: PouchChatLog;
  readonly names: Readonly<Record<string, string>>;
  readonly now?: () => number;
  /** Host inbox written during this round. Absent keeps the @-text fallback. */
  readonly readInbox?: (query: InboxQuery) => OrchestrationInbox | undefined;
}

function memberName(id: string, names: Readonly<Record<string, string>>): string {
  if (id === SHE_AGENT_ID) return names[id]?.trim() || SHE_AGENT_NAME;
  return names[id]?.trim() || id;
}

function textMessage(input: {
  channelId: string;
  senderId: string;
  senderType: string;
  senderName: string;
  content: string;
  now: number;
}): PouchMessage {
  return {
    id: randomUUID(),
    channel_id: input.channelId,
    type: 'text',
    content: input.content,
    timestamp: input.now,
    from: { id: input.senderId, type: input.senderType, name: input.senderName },
    metadata: {},
  };
}

function stringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => String(item));
}

function memberByToken(token: string, members: readonly GroupMember[]): GroupMember | undefined {
  const name = token.trim();
  if (!name) return undefined;
  return members.find((member) => member.id === name || member.name === name);
}

/**
 * What the next wave should say. Inbox wins over @ in the admin's text.
 * `done` and `pause` stop the round. Dispatch beats mention.
 */
export function planFollowUp(input: {
  inbox?: OrchestrationInbox;
  adminText: string;
  content: string;
  members: readonly GroupMember[];
  spoke: ReadonlySet<string>;
  adminLed: boolean;
}): FollowTurn[] {
  const inbox = input.inbox;
  if (inbox?.finish === 'done' || inbox?.finish === 'pause') return [];
  const dispatched = dispatchTurns(inbox, input.members, input.spoke);
  if (dispatched.length > 0) return dispatched;
  const mentioned = mentionTurns(inbox, input.members, input.spoke, input.content);
  if (mentioned.length > 0) return mentioned;
  if (inbox?.finish === 'continue' || !input.adminLed) return [];
  const prompt = input.adminText.length > 0
    ? `${input.content}\n\n${input.adminText}`
    : input.content;
  return membersMentionedIn(input.adminText, input.members)
    .filter((member) => !input.spoke.has(member.id))
    .map((member) => ({ member, prompt, concurrent: false }));
}

function dispatchTurns(
  inbox: OrchestrationInbox | undefined,
  members: readonly GroupMember[],
  spoke: ReadonlySet<string>,
): FollowTurn[] {
  const steps = [...(inbox?.steps ?? [])].sort(
    (a, b) => (a.step ?? 0) - (b.step ?? 0),
  );
  if (steps.length === 0) return [];
  const concurrent = inbox?.mode !== 'sequential';
  const turns: FollowTurn[] = [];
  for (const step of steps) {
    for (const token of step.agents) {
      const member = memberByToken(token, members);
      if (!member || spoke.has(member.id) || turns.some((turn) => turn.member.id === member.id)) {
        continue;
      }
      turns.push({ member, prompt: step.task, concurrent });
    }
  }
  return turns;
}

function mentionTurns(
  inbox: OrchestrationInbox | undefined,
  members: readonly GroupMember[],
  spoke: ReadonlySet<string>,
  content: string,
): FollowTurn[] {
  const listed = inbox?.mentions ?? [];
  if (listed.length === 0) return [];
  const turns: FollowTurn[] = [];
  const wantAll = listed.some((item) => item.name.trim().toLowerCase() === 'all' && item.notify !== false);
  const pool = wantAll
    ? members.filter((member) => !spoke.has(member.id))
    : listed.flatMap((item) => {
        if (item.notify === false) return [];
        const member = memberByToken(item.name, members);
        return member && !spoke.has(member.id) ? [member] : [];
      });
  for (const member of pool) {
    if (turns.some((turn) => turn.member.id === member.id)) continue;
    const reason = listed.find((item) => item.name === member.name || item.name === member.id)?.reason;
    const prompt = reason && reason.length > 0 ? `${content}\n\n${reason}` : content;
    turns.push({ member, prompt, concurrent: false });
  }
  return turns;
}

async function speakOne(
  member: GroupMember,
  content: string,
  channelId: string,
  deps: PouchTurnDeps,
  emit: (event: Record<string, unknown>) => void,
  now: number,
  groupId: string,
  sessionId: string,
  members: readonly GroupMember[],
): Promise<string> {
  emit({ kind: 'start', agent_id: member.id, agent_name: member.name });
  try {
    const text = await deps.speak({
      agentId: member.id,
      agentName: member.name,
      content,
      channelId,
      groupId: groupId || undefined,
      sessionId: sessionId || undefined,
      members,
      onChunk: (chunk) => {
        emit({
          kind: 'chunk',
          agent_id: member.id,
          agent_name: member.name,
          chunk,
        });
      },
    });
    deps.log.append(textMessage({
      channelId,
      senderId: member.id,
      senderType: 'agent',
      senderName: member.name,
      content: text,
      now,
    }));
    emit({
      kind: 'agent_done',
      agent_id: member.id,
      agent_name: member.name,
      skipped: false,
    });
    return text;
  } catch {
    emit({
      kind: 'agent_done',
      agent_id: member.id,
      agent_name: member.name,
      skipped: true,
    });
    return '';
  }
}

export async function runGroupTurn(
  frame: Record<string, unknown>,
  deps: PouchTurnDeps,
  emit: (event: Record<string, unknown>) => void,
): Promise<void> {
  const now = deps.now?.() ?? Date.now();
  const channelId = String(frame.channel_id ?? '');
  const content = String(frame.content ?? '');
  const userId = String(frame.user_id ?? '');
  const userName = String(frame.user_name ?? '');
  const agentIds = stringList(frame.agent_ids);
  const mentionedIds = stringList(frame.mentioned_agent_ids);
  const adminId = typeof frame.admin_agent_id === 'string' ? frame.admin_agent_id : undefined;
  const members = agentIds.map((id) => ({ id, name: memberName(id, deps.names) }));
  const groupId = stringField(frame.group_id)
    || (channelId.startsWith('group_') ? channelId : '');
  const sessionId = stringField(frame.session_id) || channelId;
  if (channelId.length > 0) {
    deps.log.append(textMessage({
      channelId,
      senderId: userId,
      senderType: 'user',
      senderName: userName,
      content,
      now,
    }));
  }
  const opening = firstRound({ members, mentionedIds, adminId });
  const adminLed = adminId !== undefined && adminId.length > 0 && mentionedIds.length === 0;
  let round: FollowTurn[] = opening.map((member) => ({
    member,
    prompt: content,
    concurrent: false,
  }));
  let followUp = adminLed || groupId.length > 0;
  const spoke = new Set<string>();
  while (round.length > 0) {
    let adminText = '';
    const pending = round.filter((turn) => !spoke.has(turn.member.id));
    for (const turn of pending) spoke.add(turn.member.id);
    const parallel = pending.length > 1 && pending.every((turn) => turn.concurrent);
    if (parallel) {
      const texts = await Promise.all(pending.map(async (turn) => {
        const text = await speakOne(
          turn.member,
          turn.prompt,
          channelId,
          deps,
          emit,
          now,
          groupId,
          sessionId,
          members,
        );
        return { id: turn.member.id, text };
      }));
      adminText = texts.find((item) => item.id === adminId)?.text ?? '';
    } else {
      for (const turn of pending) {
        const text = await speakOne(
          turn.member,
          turn.prompt,
          channelId,
          deps,
          emit,
          now,
          groupId,
          sessionId,
          members,
        );
        if (turn.member.id === adminId) adminText = text;
      }
    }
    if (!followUp) break;
    followUp = false;
    const inbox = groupId.length > 0
      ? deps.readInbox?.({ groupId, sessionId, sinceMs: now })
      : undefined;
    round = planFollowUp({
      inbox,
      adminText,
      content,
      members,
      spoke,
      adminLed,
    });
  }
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export async function runDmTurn(
  frame: Record<string, unknown>,
  deps: PouchTurnDeps,
  emit: (event: Record<string, unknown>) => void,
): Promise<void> {
  const now = deps.now?.() ?? Date.now();
  const agentId = String(frame.agent_id ?? '');
  const channelId = String(frame.channel_id ?? '');
  const content = String(frame.content ?? '');
  const userId = String(frame.user_id ?? '');
  const userName = String(frame.user_name ?? '');
  if (agentId.length === 0) throw new Error('主机上没有这个 Agent');
  const member = { id: agentId, name: memberName(agentId, deps.names) };
  if (channelId.length > 0) {
    deps.log.append(textMessage({
      channelId,
      senderId: userId,
      senderType: 'user',
      senderName: userName,
      content,
      now,
    }));
  }
  await speakOne(member, content, channelId, deps, emit, now, '', channelId, [member]);
}

function readBody(
  frame: Record<string, unknown>,
  log: PouchChatLog,
): Record<string, unknown> {
  const channelId = String(frame.channel_id ?? '');
  const limit = typeof frame.limit === 'number' ? frame.limit : 100;
  const op = String(frame.op ?? 'messages');
  if (op === 'count') {
    return { kind: 'done', count: log.count(channelId), messages: [] };
  }
  let messages: PouchMessage[] = [];
  if (op === 'older') {
    const before = Number(frame.before_created_at ?? frame.before_timestamp ?? 0);
    messages = log.older(channelId, before, limit);
  } else if (op === 'including') {
    messages = log.including(channelId, String(frame.message_id ?? ''), limit);
  } else if (op === 'one') {
    messages = log.one(channelId, String(frame.message_id ?? ''));
  } else {
    messages = log.latest(channelId, limit);
  }
  return { kind: 'done', messages };
}

const SHE_SYSTEM = [
  '你是惜宝，跑在储物袋主机上。',
  '手机和电脑只是来看和操作的。群编排和你的回合都在这台主机上完成。',
  '回答用用户正在用的语言，简短，直接。',
].join('');

export interface SheToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

interface SheToolCall {
  readonly id?: string;
  readonly function?: { readonly name?: string; readonly arguments?: string };
}

/** 惜宝的一轮。主模型地址由主机配置，不在 App 里。有工具时在这台主机上执行。 */
export async function completeSheTurn(input: {
  content: string;
  history?: readonly { role: 'user' | 'assistant'; content: string }[];
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  tools?: readonly SheToolSpec[];
  onTool?: (name: string, args: Record<string, unknown>) => Promise<string>;
}): Promise<string> {
  const baseUrl = input.baseUrl?.trim() ?? '';
  if (baseUrl.length === 0) {
    throw new Error('惜宝的主模型还没配在这台 Hub 上');
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: SHE_SYSTEM },
    ...(input.history ?? []),
    { role: 'user', content: input.content },
  ];
  const tools = input.tools ?? [];
  for (let round = 0; round < 4; round += 1) {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: input.model?.trim() || 'gpt-4o-mini',
        messages,
        ...(tools.length > 0 ? { tools: tools.map(openAiTool) } : {}),
      }),
    });
    if (!response.ok) {
      throw new Error(`惜宝的主模型返回 ${response.status}`);
    }
    const body = await response.json() as {
      choices?: Array<{ message?: { content?: string; tool_calls?: SheToolCall[] } }>;
    };
    const message = body.choices?.[0]?.message;
    const calls = message?.tool_calls ?? [];
    const text = message?.content?.trim() ?? '';
    if (calls.length === 0 || !input.onTool) {
      if (text.length === 0) throw new Error('惜宝没有返回内容');
      return text;
    }
    messages.push({
      role: 'assistant',
      content: message?.content ?? '',
      tool_calls: calls,
    });
    for (const call of calls) {
      const name = call.function?.name ?? '';
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(call.function?.arguments ?? '{}') as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        args = {};
      }
      let result = '';
      try {
        result = await input.onTool(name, args);
      } catch (err) {
        result = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
      messages.push({
        role: 'tool',
        tool_call_id: call.id ?? name,
        content: result,
      });
    }
  }
  throw new Error('惜宝的工具回合没有结束');
}

function openAiTool(tool: SheToolSpec): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

/**
 * 处理一条储物袋控制帧。事件帧带上 `type` 和 `request_id`，和 App 的
 * `pouch_turn_event` 对齐。
 */
export async function handlePouchFrame(
  frame: Record<string, unknown>,
  send: (event: Record<string, unknown>) => void,
  deps: PouchTurnDeps,
): Promise<void> {
  const requestId = String(frame.request_id ?? '');
  const emit = (event: Record<string, unknown>): void => {
    send({ type: POUCH_TURN_EVENT, request_id: requestId, ...event });
  };
  const type = String(frame.type ?? '');
  try {
    if (type === POUCH_GROUP_TURN) {
      await runGroupTurn(frame, deps, emit);
      emit({ kind: 'done' });
      return;
    }
    if (type === POUCH_DM_TURN) {
      await runDmTurn(frame, deps, emit);
      emit({ kind: 'done' });
      return;
    }
    if (type === POUCH_CHAT_READ) {
      emit(readBody(frame, deps.log));
      return;
    }
    if (type === POUCH_INTERACTION_RESP) return;
    emit({ kind: 'error', message: '未知的储物袋回合' });
  } catch (err) {
    emit({
      kind: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
