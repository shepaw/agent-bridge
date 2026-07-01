import { describe, expect, it } from 'vitest';
import type * as acp from '@agentclientprotocol/sdk';

import {
  buildActions,
  extractCommand,
  extractPaths,
  formatPermissionPrompt,
  pickOption,
  resolveSelectedOption,
} from '../src/permission/format.js';

const OPTIONS: acp.PermissionOption[] = [
  { optionId: 'opt-allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'opt-always', name: 'Allow always', kind: 'allow_always' },
  { optionId: 'opt-reject', name: 'Reject', kind: 'reject_once' },
];

describe('extractCommand', () => {
  it('reads a string command from rawInput', () => {
    const tc = { toolCallId: 't', rawInput: { command: 'npm test' } } as acp.ToolCallUpdate;
    expect(extractCommand(tc)).toBe('npm test');
  });
  it('joins an argv array', () => {
    const tc = { toolCallId: 't', rawInput: { command: ['git', 'push', 'origin'] } } as acp.ToolCallUpdate;
    expect(extractCommand(tc)).toBe('git push origin');
  });
  it('falls back to the title', () => {
    const tc = { toolCallId: 't', title: 'Read file' } as acp.ToolCallUpdate;
    expect(extractCommand(tc)).toBe('Read file');
  });
});

describe('extractPaths', () => {
  it('collects locations, diff paths and rawInput path', () => {
    const tc = {
      toolCallId: 't',
      locations: [{ path: '/a.ts' }, { path: '/b.ts' }],
      content: [{ type: 'diff', path: '/c.ts', newText: 'x' }],
      rawInput: { file_path: '/d.ts' },
    } as unknown as acp.ToolCallUpdate;
    expect(extractPaths(tc).sort()).toEqual(['/a.ts', '/b.ts', '/c.ts', '/d.ts']);
  });
});

describe('formatPermissionPrompt', () => {
  it('includes the command and affected files for an execute tool', () => {
    const tc = {
      toolCallId: 't',
      kind: 'execute',
      title: 'Run tests',
      rawInput: { command: 'npm test' },
      locations: [{ path: '/pkg/app.ts' }],
    } as unknown as acp.ToolCallUpdate;
    const prompt = formatPermissionPrompt('Claude', tc);
    expect(prompt).toContain('Claude');
    expect(prompt).toContain('run a command');
    expect(prompt).toContain('npm test');
    expect(prompt).toContain('/pkg/app.ts');
  });

  it('renders a diff preview for edits', () => {
    const tc = {
      toolCallId: 't',
      kind: 'edit',
      title: 'Edit file',
      content: [{ type: 'diff', path: '/x.ts', oldText: 'a', newText: 'b' }],
    } as unknown as acp.ToolCallUpdate;
    const prompt = formatPermissionPrompt('Codex', tc);
    expect(prompt).toContain('Modify: /x.ts');
    expect(prompt).toContain('- a');
    expect(prompt).toContain('+ b');
  });
});

describe('buildActions', () => {
  it('maps options to styled actions carrying the optionId', () => {
    const actions = buildActions(OPTIONS);
    expect(actions).toEqual([
      { id: 'opt-allow', value: 'opt-allow', label: 'Allow', style: 'primary' },
      { id: 'opt-always', value: 'opt-always', label: 'Allow always', style: 'secondary' },
      { id: 'opt-reject', value: 'opt-reject', label: 'Reject', style: 'danger' },
    ]);
  });
  it('falls back to allow/deny when the agent gives no options', () => {
    const actions = buildActions([]);
    expect(actions.map((a) => a.value)).toEqual(['allow', 'deny']);
  });
});

describe('pickOption', () => {
  it('prefers allow_once then allow_always', () => {
    expect(pickOption(OPTIONS, 'allow')).toBe('opt-allow');
    expect(pickOption([OPTIONS[1]!, OPTIONS[2]!], 'allow')).toBe('opt-always');
  });
  it('picks reject for deny', () => {
    expect(pickOption(OPTIONS, 'deny')).toBe('opt-reject');
  });
});

describe('resolveSelectedOption (the app reply mapping)', () => {
  it('maps selected_action_id back to the ACP optionId (the fixed bug)', () => {
    const res = resolveSelectedOption(OPTIONS, {
      confirmation_id: 'c1',
      selected_action_id: 'opt-reject',
      selected_action_label: 'Reject',
    });
    expect(res).toBe('opt-reject');
  });
  it('matches by label when id is absent', () => {
    expect(resolveSelectedOption(OPTIONS, { selected_action_label: 'Allow always' })).toBe('opt-always');
  });
  it('keyword fallback resolves allow/deny', () => {
    expect(resolveSelectedOption(OPTIONS, { action: 'yes' })).toBe('opt-allow');
    expect(resolveSelectedOption(OPTIONS, { action: 'no' })).toBe('opt-reject');
  });
  it('returns undefined for an empty/unknown reply', () => {
    expect(resolveSelectedOption(OPTIONS, {})).toBeUndefined();
  });
});
