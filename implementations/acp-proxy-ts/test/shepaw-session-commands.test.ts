import { describe, expect, it } from 'vitest';
import {
  GROUP_SESSION_NEW_COMMAND,
  SESSION_NEW_COMMAND,
  expandSessionSlashPrompt,
  mergeShepawSessionCommands,
} from '../src/shepaw-session-commands.js';

describe('mergeShepawSessionCommands', () => {
  it('appends both commands when the engine list is empty', () => {
    const out = mergeShepawSessionCommands([]);
    expect(out.map((c) => c.name)).toEqual([
      SESSION_NEW_COMMAND.name,
      GROUP_SESSION_NEW_COMMAND.name,
    ]);
  });

  it('does not duplicate an already-listed command', () => {
    const out = mergeShepawSessionCommands([
      { name: 'session-new', description: 'upstream' },
      { name: 'compact' },
    ]);
    expect(out.map((c) => c.name)).toEqual([
      'session-new',
      'compact',
      'group-session-new',
    ]);
    expect(out[0]).toMatchObject({ description: 'upstream' });
  });

  it('teaches the shepaw CLI in the description', () => {
    expect(SESSION_NEW_COMMAND.description).toContain(
      'shepaw chat session create',
    );
    expect(GROUP_SESSION_NEW_COMMAND.description).toContain(
      'shepaw chat group session create',
    );
  });
});

describe('expandSessionSlashPrompt', () => {
  it('expands /session-new into a CLI instruction', () => {
    const out = expandSessionSlashPrompt('/session-new --reason user_requested');
    expect(out.startsWith('/session-new --reason user_requested')).toBe(true);
    expect(out).toContain('[session-new]');
    expect(out).toContain('shepaw chat session create');
    expect(out).toContain('Do not assume they switched');
  });

  it('expands /group-session-new and is idempotent', () => {
    const out = expandSessionSlashPrompt('/group-session-new');
    expect(out).toContain('shepaw chat group session create');
    expect(expandSessionSlashPrompt(out)).toBe(out);
  });

  it('leaves ordinary prompts unchanged', () => {
    expect(expandSessionSlashPrompt('hello')).toBe('hello');
    expect(expandSessionSlashPrompt('/compact')).toBe('/compact');
  });
});
