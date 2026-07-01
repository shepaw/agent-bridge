import { describe, expect, it } from 'vitest';
import type * as acp from '@agentclientprotocol/sdk';

import { PermissionPolicy, loadPolicyFromEnv, DEFAULT_POLICY } from '../src/permission/policy.js';

function toolCall(
  kind: acp.ToolKind,
  title: string,
  rawInput?: unknown,
): acp.ToolCallUpdate {
  return { toolCallId: 'tc1', kind, title, rawInput } as acp.ToolCallUpdate;
}

describe('loadPolicyFromEnv', () => {
  it('defaults to ask mode with no rules', () => {
    const cfg = loadPolicyFromEnv({});
    expect(cfg.mode).toBe('ask');
    expect(cfg.allowKinds).toEqual([]);
    expect(cfg.denyPatterns).toEqual([]);
  });

  it('parses mode, kinds and patterns, filtering invalid kinds', () => {
    const cfg = loadPolicyFromEnv({
      PAW_ACP_APPROVAL_MODE: 'custom',
      PAW_ACP_APPROVAL_ALLOW_KINDS: 'read, search, bogus, fetch',
      PAW_ACP_APPROVAL_ASK_KINDS: 'execute,delete',
      PAW_ACP_APPROVAL_ALLOW_PATTERNS: 'npm (test|run)\n^ls ',
      PAW_ACP_APPROVAL_DENY_PATTERNS: 'rm -rf',
    });
    expect(cfg.mode).toBe('custom');
    expect(cfg.allowKinds).toEqual(['read', 'search', 'fetch']);
    expect(cfg.askKinds).toEqual(['execute', 'delete']);
    expect(cfg.allowPatterns).toEqual(['npm (test|run)', '^ls']);
    expect(cfg.denyPatterns).toEqual(['rm -rf']);
  });

  it('treats yolo as auto', () => {
    expect(loadPolicyFromEnv({ PAW_ACP_APPROVAL_MODE: 'yolo' }).mode).toBe('auto');
  });
});

describe('PermissionPolicy.decide', () => {
  it('always asks with the default policy', () => {
    const p = new PermissionPolicy(DEFAULT_POLICY);
    expect(p.decide(toolCall('execute', 'run', { command: 'ls' })).decision).toBe('ask');
    expect(p.canAutoDecide).toBe(false);
  });

  it('deny patterns win over everything (even auto mode)', () => {
    const p = new PermissionPolicy({
      ...DEFAULT_POLICY,
      mode: 'auto',
      denyPatterns: ['rm -rf'],
    });
    expect(p.decide(toolCall('execute', 'cleanup', { command: 'rm -rf /tmp/x' })).decision).toBe('deny');
    expect(p.decide(toolCall('execute', 'list', { command: 'ls -la' })).decision).toBe('allow');
  });

  it('ask kinds override allow kinds and auto mode', () => {
    const p = new PermissionPolicy({
      ...DEFAULT_POLICY,
      mode: 'auto',
      askKinds: ['execute'],
    });
    expect(p.decide(toolCall('execute', 'run', { command: 'ls' })).decision).toBe('ask');
    expect(p.decide(toolCall('read', 'open', {})).decision).toBe('allow');
  });

  it('custom mode: allow kinds and allow patterns', () => {
    const p = new PermissionPolicy({
      ...DEFAULT_POLICY,
      mode: 'custom',
      allowKinds: ['read', 'search'],
      allowPatterns: ['^npm (test|run)'],
    });
    expect(p.decide(toolCall('read', 'open file', {})).decision).toBe('allow');
    expect(p.decide(toolCall('execute', 'npm test', { command: 'npm test' })).decision).toBe('allow');
    // execute not in allowKinds and command doesn't match → ask
    expect(p.decide(toolCall('execute', 'deploy', { command: 'deploy prod' })).decision).toBe('ask');
  });

  it('matches patterns against title + command', () => {
    const p = new PermissionPolicy({ ...DEFAULT_POLICY, mode: 'custom', allowPatterns: ['deploy'] });
    // command carries the match
    expect(p.decide(toolCall('execute', 'run', { command: './deploy.sh' })).decision).toBe('allow');
    // title carries the match
    expect(p.decide(toolCall('other', 'deploy service', {})).decision).toBe('allow');
  });

  it('ignores invalid regex without crashing', () => {
    const p = new PermissionPolicy({ ...DEFAULT_POLICY, mode: 'custom', denyPatterns: ['('] });
    expect(p.decide(toolCall('execute', 'run', { command: 'ls' })).decision).toBe('ask');
  });
});
