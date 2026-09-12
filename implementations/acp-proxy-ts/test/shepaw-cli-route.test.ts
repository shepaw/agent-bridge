import { describe, expect, it } from 'vitest';
import {
  isSessionCreateCommand,
  joinSubcommand,
  shouldForwardToApp,
} from '../src/shepaw-cli-route.js';

describe('joinSubcommand', () => {
  it('joins chat session create', () => {
    expect(joinSubcommand(['chat', 'session', 'create'])).toEqual({
      namespace: 'chat',
      subcommand: 'session.create',
    });
  });

  it('joins chat group session create', () => {
    expect(joinSubcommand(['chat', 'group', 'session', 'create'])).toEqual({
      namespace: 'chat',
      subcommand: 'group.session.create',
    });
  });
});

describe('isSessionCreateCommand', () => {
  it('recognizes dm and group session create', () => {
    expect(isSessionCreateCommand('chat', 'session.create')).toBe(true);
    expect(isSessionCreateCommand('chat', 'group.session.create')).toBe(true);
    expect(isSessionCreateCommand('chat', 'messages')).toBe(false);
    expect(isSessionCreateCommand('store', 'write')).toBe(false);
  });
});

describe('shouldForwardToApp', () => {
  it('forwards chat session create when hub forward is on', () => {
    expect(
      shouldForwardToApp({
        namespace: 'chat',
        subcommand: 'session.create',
        flags: {},
        hubDeviceId: 'aaaaaaaaaaaaaaaa',
        hubForwardEnabled: true,
      }),
    ).toBe(true);
  });

  it('keeps local store on hub', () => {
    expect(
      shouldForwardToApp({
        namespace: 'store',
        subcommand: 'write',
        flags: {},
        hubDeviceId: 'aaaaaaaaaaaaaaaa',
        hubForwardEnabled: true,
      }),
    ).toBe(false);
  });
});
