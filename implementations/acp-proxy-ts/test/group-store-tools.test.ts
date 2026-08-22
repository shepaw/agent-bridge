import { describe, expect, it } from 'vitest';

import {
  buildInboxWrite,
  groupToolDefs,
  inboxRelPath,
  readGroupStoreMcpEnv,
} from '../src/group-store-tools.js';

describe('readGroupStoreMcpEnv', () => {
  it('parses group env and member names', () => {
    const envCtx = readGroupStoreMcpEnv({
      GROUP_ID: 'group_abc',
      GROUP_SESSION_ID: 'group_session_1',
      GROUP_WORKSPACE_ROOT: 'group_group_abc',
      GROUP_MEMBER_NAMES: 'She, Coder',
    });
    expect(envCtx).not.toBeNull();
    expect(envCtx?.memberNames).toEqual(['She', 'Coder']);
  });

  it('returns null when group env is incomplete', () => {
    expect(readGroupStoreMcpEnv({ GROUP_ID: 'group_abc' })).toBeNull();
  });
});

describe('groupToolDefs', () => {
  it('exposes the three orchestration tools with member-name enums', () => {
    const defs = groupToolDefs(['She', 'Coder']);
    expect(defs.map((d) => d.name)).toEqual([
      'group_dispatch',
      'group_finish',
      'group_mention',
    ]);
    const dispatchSchema = defs[0]!.inputSchema;
    const agentItems = (
      (dispatchSchema.properties as Record<string, unknown>).steps as {
        items: {
          properties: Record<string, unknown>;
        };
      }
    ).items.properties.agents as { items: { enum?: string[] } };
    expect(agentItems.items.enum).toEqual(['She', 'Coder']);
  });
});

describe('inboxRelPath', () => {
  it('builds the orchestration inbox path under the workspace root', () => {
    const envCtx = readGroupStoreMcpEnv({
      GROUP_ID: 'group_abc',
      GROUP_SESSION_ID: 'group_session_1',
      GROUP_WORKSPACE_ROOT: 'group_group_abc',
    })!;
    expect(inboxRelPath(envCtx, 'dispatch.json')).toBe(
      'group_group_abc/shared/orchestration/group_session_1/inbox/dispatch.json',
    );
  });
});

describe('buildInboxWrite (tool validation + inbox payload)', () => {
  it('group_dispatch → inbox/dispatch.json with mode + steps', () => {
    const planned = buildInboxWrite('group_dispatch', {
      mode: 'sequential',
      steps: [{ step: 1, agents: ['Coder'], task: '实现登录' }],
    });
    expect('error' in planned).toBe(false);
    if ('error' in planned) return;
    expect(planned.file).toBe('dispatch.json');
    expect(planned.payload.kind).toBe('dispatch');
    expect(planned.payload.mode).toBe('sequential');
    expect(planned.payload.steps).toEqual([
      { step: 1, agents: ['Coder'], task: '实现登录' },
    ]);
  });

  it('group_dispatch defaults mode to concurrent', () => {
    const planned = buildInboxWrite('group_dispatch', {
      steps: [{ agents: ['Coder'], task: 'x' }],
    });
    if ('error' in planned) throw new Error(planned.error);
    expect(planned.payload.mode).toBe('concurrent');
  });

  it('group_dispatch rejects empty steps', () => {
    const planned = buildInboxWrite('group_dispatch', { steps: [] });
    expect('error' in planned).toBe(true);
    if ('error' in planned) expect(planned.error).toContain('non-empty');
  });

  it('group_finish → inbox/finish.json with validated action', () => {
    const planned = buildInboxWrite('group_finish', { action: 'pause' });
    if ('error' in planned) throw new Error(planned.error);
    expect(planned.file).toBe('finish.json');
    expect(planned.payload).toEqual({ kind: 'finish', action: 'pause' });
  });

  it('group_finish rejects unknown action', () => {
    const planned = buildInboxWrite('group_finish', { action: 'nope' });
    expect('error' in planned).toBe(true);
    if ('error' in planned) {
      expect(planned.error).toContain('done|continue|pause');
    }
  });

  it('group_mention → inbox/mentions.json with declarations', () => {
    const planned = buildInboxWrite('group_mention', {
      mentions: [{ name: 'Coder', reason: '需要协助' }],
    });
    if ('error' in planned) throw new Error(planned.error);
    expect(planned.file).toBe('mentions.json');
    expect(planned.payload.mentions).toEqual([
      { name: 'Coder', reason: '需要协助' },
    ]);
  });

  it('rejects unknown tools', () => {
    const planned = buildInboxWrite('group_bogus', {});
    expect('error' in planned).toBe(true);
  });
});
