import { describe, expect, it } from 'vitest';
import type * as acp from '@agentclientprotocol/sdk';

import {
  advertisedModesList,
  findModeConfigOption,
  matchRequestedModeId,
  planRequestedMode,
  requestedSessionMode,
} from '../src/session-mode.js';

const CURSOR_MODES = [
  { id: 'agent', name: 'Agent' },
  { id: 'plan', name: 'Plan' },
  { id: 'ask', name: 'Ask' },
  { id: 'auto', name: 'Auto' },
];

const CLAUDE_MODES = [
  { id: 'default', name: 'Default' },
  { id: 'acceptEdits', name: 'Accept Edits' },
  { id: 'plan', name: 'Plan' },
  { id: 'auto', name: 'Auto' },
  { id: 'dontAsk', name: "Don't Ask" },
  { id: 'bypassPermissions', name: 'Bypass Permissions' },
];

const CODEX_MODES = [
  { id: 'untrusted', name: 'Untrusted' },
  { id: 'on-request', name: 'On request' },
  { id: 'on-failure', name: 'On failure' },
  { id: 'never', name: 'Never' },
];

describe('requestedSessionMode', () => {
  it('is unset by default', () => {
    expect(requestedSessionMode({})).toBeUndefined();
  });
  it('reads PAW_ACP_SESSION_MODE', () => {
    expect(requestedSessionMode({ PAW_ACP_SESSION_MODE: ' auto ' })).toBe('auto');
  });
});

describe('matchRequestedModeId', () => {
  it('matches Cursor catalog ids exactly', () => {
    expect(matchRequestedModeId(CURSOR_MODES, 'auto', 'ask')).toBe('auto');
    expect(matchRequestedModeId(CURSOR_MODES, 'agent', 'ask')).toBe('agent');
    expect(matchRequestedModeId(CURSOR_MODES, 'plan', 'agent')).toBe('plan');
  });

  it('matches advertised yolo when Hub requested auto', () => {
    expect(matchRequestedModeId([{ id: 'yolo', name: 'Yolo' }, { id: 'ask', name: 'Ask' }], 'auto', 'ask')).toBe('yolo');
  });

  it('matches Claude catalog ids', () => {
    expect(matchRequestedModeId(CLAUDE_MODES, 'bypassPermissions', 'default')).toBe('bypassPermissions');
    expect(matchRequestedModeId(CLAUDE_MODES, 'acceptEdits', 'default')).toBe('acceptEdits');
    expect(matchRequestedModeId(CLAUDE_MODES, 'dontAsk', 'default')).toBe('dontAsk');
  });

  it('matches Codex never / on-request / on-failure', () => {
    expect(matchRequestedModeId(CODEX_MODES, 'never', 'on-request')).toBe('never');
    expect(matchRequestedModeId(CODEX_MODES, 'on-request', 'auto')).toBe('on-request');
    expect(matchRequestedModeId(CODEX_MODES, 'full-auto', 'on-request')).toBe('never');
    expect(matchRequestedModeId(CODEX_MODES, 'auto', 'on-request')).toBe('on-failure');
  });

  it('maps Hub agent to OpenCode build', () => {
    expect(matchRequestedModeId(
      [{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }],
      'agent',
      'plan',
    )).toBe('build');
  });

  it('returns undefined when already on the requested mode', () => {
    expect(matchRequestedModeId(CURSOR_MODES, 'agent', 'agent')).toBeUndefined();
  });

  it('returns undefined when nothing advertised matches', () => {
    expect(matchRequestedModeId(CURSOR_MODES, 'bypassPermissions', 'agent')).toBeUndefined();
  });

  it('does not auto-pick the most autonomous mode', () => {
    expect(matchRequestedModeId(CLAUDE_MODES, 'default', 'plan')).toBe('default');
  });
});

describe('advertisedModesList', () => {
  it('maps configOptions category=mode', () => {
    const list = advertisedModesList({
      configOptions: [
        {
          id: 'mode',
          name: 'Session Mode',
          type: 'select',
          category: 'mode',
          currentValue: 'ask',
          options: [
            { value: 'ask', name: 'Ask', description: 'Read only' },
            { value: 'agent', name: 'Agent' },
          ],
        },
      ],
    });
    expect(list.current).toBe('ask');
    expect(list.modes).toEqual([
      { value: 'ask', display_name: 'Ask', description: 'Read only' },
      { value: 'agent', display_name: 'Agent', description: '' },
    ]);
  });

  it('falls back to legacy availableModes', () => {
    const list = advertisedModesList({
      modes: {
        currentModeId: 'agent',
        availableModes: [
          { id: 'agent', name: 'Agent', description: 'Full tools' },
          { id: 'plan', name: 'Plan' },
        ],
      },
    });
    expect(list.current).toBe('agent');
    expect(list.modes[1]).toEqual({ value: 'plan', display_name: 'Plan', description: '' });
  });

  it('prefers currentOverride when it is in the list', () => {
    const list = advertisedModesList({
      currentOverride: 'plan',
      modes: {
        currentModeId: 'agent',
        availableModes: [
          { id: 'agent', name: 'Agent' },
          { id: 'plan', name: 'Plan' },
        ],
      },
    });
    expect(list.current).toBe('plan');
  });
});

describe('planRequestedMode', () => {
  it('prefers configOptions category=mode over legacy modes', () => {
    const plan = planRequestedMode({
      requested: 'auto',
      configOptions: [
        {
          id: 'mode',
          name: 'Session Mode',
          type: 'select',
          category: 'mode',
          currentValue: 'ask',
          options: [
            { value: 'ask', name: 'Ask' },
            { value: 'agent', name: 'Agent' },
            { value: 'auto', name: 'Auto' },
          ],
        },
      ],
      modes: {
        currentModeId: 'ask',
        availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'agent', name: 'Agent' }],
      },
    });
    expect(plan).toEqual({ kind: 'config-select', configId: 'mode', value: 'auto' });
  });

  it('falls back to session/set_mode', () => {
    const plan = planRequestedMode({
      requested: 'agent',
      configOptions: [],
      modes: {
        currentModeId: 'ask',
        availableModes: [
          { id: 'ask', name: 'Ask' },
          { id: 'plan', name: 'Plan' },
          { id: 'agent', name: 'Agent' },
        ],
      },
    });
    expect(plan).toEqual({ kind: 'set-mode', modeId: 'agent' });
  });

  it('does nothing when the requested mode is not advertised', () => {
    const plan = planRequestedMode({
      requested: 'bypassPermissions',
      configOptions: [],
      modes: {
        currentModeId: 'ask',
        availableModes: CURSOR_MODES,
      },
    });
    expect(plan).toBeUndefined();
  });
});

describe('findModeConfigOption', () => {
  it('does not confuse model with mode', () => {
    const opts: acp.SessionConfigOption[] = [
      {
        id: 'model',
        name: 'Model',
        type: 'select',
        category: 'model',
        currentValue: 'a',
        options: [{ value: 'a', name: 'A' }],
      },
    ];
    expect(findModeConfigOption(opts)).toBeUndefined();
  });

  it('finds permissionMode by name', () => {
    const opt = findModeConfigOption([
      {
        id: 'permissionMode',
        name: 'Permission Mode',
        type: 'select',
        currentValue: 'default',
        options: [{ value: 'default', name: 'Default' }],
      },
    ]);
    expect(opt?.id).toBe('permissionMode');
  });

  it('finds Codex approvalPolicy by id', () => {
    const opt = findModeConfigOption([
      {
        id: 'model',
        name: 'Model',
        type: 'select',
        category: 'model',
        currentValue: 'gpt',
        options: [{ value: 'gpt', name: 'GPT' }],
      },
      {
        id: 'approvalPolicy',
        name: 'Approval policy',
        type: 'select',
        currentValue: 'on-request',
        options: [
          { value: 'on-request', name: 'On request' },
          { value: 'never', name: 'Never' },
        ],
      },
    ]);
    expect(opt?.id).toBe('approvalPolicy');
  });
});
