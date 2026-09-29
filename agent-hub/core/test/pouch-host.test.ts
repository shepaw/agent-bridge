import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SHE_AGENT_ID,
  PouchChatLog,
  completeSheTurn,
  firstRound,
  handlePouchFrame,
  membersMentionedIn,
  planFollowUp,
  POUCH_TURN_EVENT,
} from '../src/peer/pouch-host.js';
import type { MemberSpeaker } from '../src/peer/pouch-host.js';

const members = [
  { id: SHE_AGENT_ID, name: '惜宝' },
  { id: 'codex', name: 'Codex' },
  { id: 'claude', name: 'Claude' },
];

describe('firstRound', () => {
  it('没有点名时先只让管理员说', () => {
    expect(firstRound({
      members,
      mentionedIds: [],
      adminId: SHE_AGENT_ID,
    }).map((m) => m.id)).toEqual([SHE_AGENT_ID]);
  });

  it('用户点了名就只叫那些人', () => {
    expect(firstRound({
      members,
      mentionedIds: ['codex'],
      adminId: SHE_AGENT_ID,
    }).map((m) => m.id)).toEqual(['codex']);
  });

  it('没有管理员时全员开口', () => {
    expect(firstRound({ members, mentionedIds: [] }).map((m) => m.id))
      .toEqual([SHE_AGENT_ID, 'codex', 'claude']);
  });
});

describe('membersMentionedIn', () => {
  it('长名字不会被短名字截走', () => {
    const named = [
      { id: 'a', name: '张' },
      { id: 'b', name: '张三' },
    ];
    expect(membersMentionedIn('请 @张三 看一下', named).map((m) => m.id))
      .toEqual(['b']);
  });
});

describe('handlePouchFrame', () => {
  it('管理员点名之后才叫下一位，并把两轮记进聊天', async () => {
    const seen: string[] = [];
    const speak: MemberSpeaker = async (req) => {
      seen.push(req.agentId);
      const text = req.agentId === SHE_AGENT_ID ? '交给 @Codex' : '好的';
      req.onChunk(text);
      return text;
    };
    const log = new PouchChatLog();
    const events: Record<string, unknown>[] = [];
    await handlePouchFrame(
      {
        type: 'pouch_group_turn',
        request_id: 'r1',
        channel_id: 'ch',
        content: '看一下这个',
        user_id: 'u',
        user_name: '我',
        agent_ids: members.map((m) => m.id),
        mentioned_agent_ids: [],
        admin_agent_id: SHE_AGENT_ID,
      },
      (event) => events.push(event),
      {
        speak,
        log,
        names: { [SHE_AGENT_ID]: '惜宝', codex: 'Codex', claude: 'Claude' },
        now: () => 1,
      },
    );
    expect(seen).toEqual([SHE_AGENT_ID, 'codex']);
    expect(events[0]).toMatchObject({ type: POUCH_TURN_EVENT, kind: 'start', agent_id: SHE_AGENT_ID });
    expect(events.at(-1)).toMatchObject({ kind: 'done' });
    expect(log.count('ch')).toBe(3);
  });

  it('inbox 里的 dispatch 决定下一位，finish done 则停', async () => {
    const seen: string[] = [];
    const speak: MemberSpeaker = async (req) => {
      seen.push(req.agentId);
      req.onChunk('好');
      return '好';
    };
    await handlePouchFrame(
      {
        type: 'pouch_group_turn',
        request_id: 'r-inbox',
        channel_id: 'group_abc',
        content: '看一下',
        user_id: 'u',
        user_name: '我',
        agent_ids: members.map((m) => m.id),
        admin_agent_id: SHE_AGENT_ID,
      },
      () => {},
      {
        speak,
        log: new PouchChatLog(),
        names: { [SHE_AGENT_ID]: '惜宝', codex: 'Codex', claude: 'Claude' },
        now: () => 1,
        readInbox: () => ({ finish: 'done' }),
      },
    );
    expect(seen).toEqual([SHE_AGENT_ID]);
  });

  it('单聊惜宝失败时记成跳过，不把整轮打成未知错误', async () => {
    const events: Record<string, unknown>[] = [];
    await handlePouchFrame(
      {
        type: 'pouch_dm_turn',
        request_id: 'r2',
        channel_id: 'dm',
        agent_id: SHE_AGENT_ID,
        content: '在吗',
        user_id: 'u',
        user_name: '我',
      },
      (event) => events.push(event),
      {
        speak: async () => {
          throw new Error('惜宝的主模型还没配在这台 Hub 上');
        },
        log: new PouchChatLog(),
        names: {},
      },
    );
    expect(events.some((e) => e.kind === 'agent_done' && e.skipped === true)).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: 'done' });
  });

  it('读回刚写下的一页', async () => {
    const log = new PouchChatLog();
    const events: Record<string, unknown>[] = [];
    await handlePouchFrame(
      {
        type: 'pouch_dm_turn',
        request_id: 'r3',
        channel_id: 'dm',
        agent_id: 'codex',
        content: '你好',
        user_id: 'u',
        user_name: '我',
      },
      () => {},
      {
        speak: async (req) => {
          req.onChunk('在');
          return '在';
        },
        log,
        names: { codex: 'Codex' },
        now: () => 5,
      },
    );
    await handlePouchFrame(
      { type: 'pouch_chat_read', request_id: 'r4', channel_id: 'dm', op: 'messages' },
      (event) => events.push(event),
      { speak: async () => '', log, names: {} },
    );
    const done = events[0];
    expect(done?.kind).toBe('done');
    expect(done?.messages).toHaveLength(2);
  });
});

describe('planFollowUp', () => {
  const members = [
    { id: SHE_AGENT_ID, name: '惜宝' },
    { id: 'codex', name: 'Codex' },
    { id: 'claude', name: 'Claude' },
  ];

  it('inbox dispatch 覆盖正文里的 @', () => {
    const turns = planFollowUp({
      inbox: {
        mode: 'sequential',
        steps: [{ agents: ['Claude'], task: '看日志' }],
      },
      adminText: '交给 @Codex',
      content: '看一下',
      members,
      spoke: new Set([SHE_AGENT_ID]),
      adminLed: true,
    });
    expect(turns.map((turn) => turn.member.id)).toEqual(['claude']);
    expect(turns[0]?.prompt).toBe('看日志');
    expect(turns[0]?.concurrent).toBe(false);
  });

  it('finish done 不再叫下一位', () => {
    expect(planFollowUp({
      inbox: { finish: 'done' },
      adminText: '交给 @Codex',
      content: '看一下',
      members,
      spoke: new Set([SHE_AGENT_ID]),
      adminLed: true,
    })).toEqual([]);
  });
});

describe('PouchChatLog disk', () => {
  it('重启后还能读回同一频道', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pouch-chat-'));
    try {
      const first = new PouchChatLog(dir);
      first.append({
        id: 'm1',
        channel_id: 'dm_1',
        type: 'text',
        content: '还在',
        timestamp: 1,
        from: { id: 'u', type: 'user', name: '我' },
        metadata: {},
      });
      const second = new PouchChatLog(dir);
      expect(second.all('dm_1').map((message) => message.content)).toEqual(['还在']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('completeSheTurn', () => {
  it('没有主模型地址时不假装答完', async () => {
    await expect(completeSheTurn({ content: '你好' })).rejects.toThrow(/主模型/);
  });

  it('把用户的话交给主机上的模型', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '我在主机上' } }],
    }), { status: 200 }));
    const text = await completeSheTurn({
      content: '在吗',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'k',
      model: 'm',
      fetchImpl,
    });
    expect(text).toBe('我在主机上');
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(String(init.body)).toContain('在吗');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k');
  });

  it('工具调用在这台主机上执行后再要最终回答', async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''));
      if (bodies.length === 1) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'call_1',
                function: { name: 'store_read', arguments: '{"uri":"store://files/aa/a.md"}' },
              }],
            },
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: '读完了' } }],
      }), { status: 200 });
    });
    const seen: string[] = [];
    const text = await completeSheTurn({
      content: '读一下',
      baseUrl: 'http://127.0.0.1:9/v1',
      tools: [{ name: 'store_read', description: 'read', parameters: { type: 'object' } }],
      onTool: async (name) => {
        seen.push(name);
        return '{"content":"hello"}';
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(seen).toEqual(['store_read']);
    expect(text).toBe('读完了');
    expect(bodies[1]).toContain('hello');
  });
});
