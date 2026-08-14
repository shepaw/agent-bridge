import { describe, expect, it } from 'vitest';
import type * as acp from '@agentclientprotocol/sdk';

import {
  advertisedModesList,
  cursorRunModeSpawnArgs,
  findModeConfigOption,
  matchRequestedModeId,
  planRequestedMode,
  requestedSessionMode,
} from '../src/session-mode.js';

const CURSOR_RUN_MODES = [
  { id: 'auto-review', name: 'Auto-review' },
  { id: 'allowlist', name: 'Allowlist' },
  { id: 'unrestricted', name: 'Run Everything' },
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
  it('matches Cursor run mode ids', () => {
    expect(matchRequestedModeId(CURSOR_RUN_MODES, 'auto-review', 'allowlist')).toBe('auto-review');
    expect(matchRequestedModeId(CURSOR_RUN_MODES, 'unrestricted', 'allowlist')).toBe('unrestricted');
    expect(matchRequestedModeId(CURSOR_RUN_MODES, 'yolo', 'allowlist')).toBe('unrestricted');
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
    expect(matchRequestedModeId(CURSOR_RUN_MODES, 'auto-review', 'auto-review')).toBeUndefined();
  });

  it('returns undefined when nothing advertised matches', () => {
    expect(matchRequestedModeId(CURSOR_RUN_MODES, 'agent', 'allowlist')).toBeUndefined();
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
  it('prefers approvalMode config over session category=mode', () => {
    const plan = planRequestedMode({
      requested: 'auto-review',
      configOptions: [
        {
          id: 'mode',
          name: 'Session Mode',
          type: 'select',
          category: 'mode',
          currentValue: 'agent',
          options: [
            { value: 'agent', name: 'Agent' },
            { value: 'plan', name: 'Plan' },
          ],
        },
        {
          id: 'approvalMode',
          name: 'Run Mode',
          type: 'select',
          currentValue: 'allowlist',
          options: [
            { value: 'allowlist', name: 'Allowlist' },
            { value: 'auto-review', name: 'Auto-review' },
            { value: 'unrestricted', name: 'Run Everything' },
          ],
        },
      ],
    });
    expect(plan).toEqual({ kind: 'config-select', configId: 'approvalMode', value: 'auto-review' });
  });

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
        currentModeId: 'agent',
        availableModes: [
          { id: 'agent', name: 'Agent' },
          { id: 'plan', name: 'Plan' },
        ],
      },
    });
    expect(plan).toBeUndefined();
  });
});

describe('cursorRunModeSpawnArgs', () => {
  it('adds --auto-review for auto-review mode', () => {
    expect(cursorRunModeSpawnArgs('auto-review', ['acp'])).toEqual(['--auto-review', 'acp']);
  });

  it('adds --force for unrestricted / yolo', () => {
    expect(cursorRunModeSpawnArgs('unrestricted', ['acp'])).toEqual(['--force', 'acp']);
    expect(cursorRunModeSpawnArgs('yolo', ['acp'])).toEqual(['--force', 'acp']);
  });

  it('leaves allowlist unchanged', () => {
    expect(cursorRunModeSpawnArgs('allowlist', ['acp'])).toEqual(['acp']);
  });

  it('does not duplicate flags', () => {
    expect(cursorRunModeSpawnArgs('auto-review', ['--auto-review', 'acp'])).toEqual(['--auto-review', 'acp']);
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

  it('prefers approvalMode over category=mode', () => {
    const opt = findModeConfigOption([
      {
        id: 'mode',
        name: 'Session Mode',
        type: 'select',
        category: 'mode',
        currentValue: 'agent',
        options: [{ value: 'agent', name: 'Agent' }],
      },
      {
        id: 'approvalMode',
        name: 'Run Mode',
        type: 'select',
        currentValue: 'allowlist',
        options: [{ value: 'auto-review', name: 'Auto-review' }],
      },
    ]);
    expect(opt?.id).toBe('approvalMode');
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
