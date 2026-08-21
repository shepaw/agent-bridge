import { describe, expect, it } from 'vitest';

import type { GroupChatContext } from 'shepaw-acp-sdk';
import {
  buildGroupTaskContextBlock,
  groupStoreWriteScope,
  isGroupTurn,
} from '../src/group-context.js';

const groupContext: GroupChatContext = {
  group_id: 'group_abc',
  group_name: '测试群',
  group_description: '一个测试群',
  member_count: 2,
  members: [
    { id: 'a1', name: 'She', type: 'agent', status: 'online' },
    { id: 'a2', name: 'Coder', type: 'agent', status: 'offline', bio: '编码' },
  ],
  is_first_message: true,
  workspace_uri: 'store://workspaces/abc/group_group_abc/shared',
  orchestration_tools: { name: 'group_dispatch' },
};

describe('isGroupTurn', () => {
  it('recognizes group turns', () => {
    expect(isGroupTurn(groupContext)).toBe(true);
  });

  it('rejects non-group kwargs', () => {
    expect(isGroupTurn(undefined)).toBe(false);
    expect(isGroupTurn(null)).toBe(false);
    expect(isGroupTurn({})).toBe(false);
    expect(isGroupTurn({ group_id: '' })).toBe(false);
  });
});

describe('buildGroupTaskContextBlock', () => {
  it('renders roster, offline marker, shared workspace and admin hint', () => {
    const block = buildGroupTaskContextBlock(groupContext);
    expect(block).not.toBeNull();
    expect(block).toContain('## 群任务上下文');
    expect(block).toContain('测试群（group_abc）');
    expect(block).toContain('成员（2）');
    expect(block).toContain('She');
    expect(block).toContain('Coder [离线]');
    expect(block).toContain('store://workspaces/abc/group_group_abc/shared');
    expect(block).toContain('group_dispatch / group_finish');
  });

  it('omits optional sections when absent', () => {
    const minimal: GroupChatContext = { group_id: 'group_x' };
    const block = buildGroupTaskContextBlock(minimal);
    expect(block).toContain('群 ID：group_x');
    expect(block).not.toContain('成员（');
    expect(block).not.toContain('群共享空间');
    expect(block).not.toContain('group_dispatch');
  });

  it('returns null without group_id', () => {
    expect(buildGroupTaskContextBlock({ group_id: '' })).toBeNull();
  });
});

describe('groupStoreWriteScope', () => {
  it('scopes owner/channel to the group so artifacts land in group runtime', () => {
    const scope = groupStoreWriteScope(groupContext, 'a2');
    expect(scope.owner).toBe('group_abc');
    expect(scope.channel).toBe('group_abc');
    expect(scope.agentId).toBe('a2');
  });
});
