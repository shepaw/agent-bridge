/**
 * Shepaw session slash commands — discovery surface, not every-turn context.
 *
 * Mirrors shepaw `ShepawSessionSlashCommands`. Hub `agent.commands.list`
 * injects both; the App picker keeps the one that matches DM vs group.
 */

export interface ShepawSessionCommand {
  name: string;
  description: string;
  argument_hint: string;
  source: 'sdk';
}

export const SESSION_NEW_COMMAND: ShepawSessionCommand = {
  name: 'session-new',
  description:
    'Open a new 1:1 session with a handoff summary (does not auto-switch). ' +
    'Run: shepaw chat session create --reason <code> --summary "..."',
  argument_hint: '--reason context_too_long --summary "key points"',
  source: 'sdk',
};

export const GROUP_SESSION_NEW_COMMAND: ShepawSessionCommand = {
  name: 'group-session-new',
  description:
    'Open a new group session with a handoff package (admin; does not ' +
    'auto-switch). Run: shepaw chat group session create --reason <code> ' +
    '--handoff-json \'{...}\'',
  argument_hint:
    '--reason topic_shift --handoff-json ' +
    '\'{"task":{"user_goal":"...","acceptance_criteria":["..."],' +
    '"status":"in_progress"}}\'',
  source: 'sdk',
};

const ALL = [SESSION_NEW_COMMAND, GROUP_SESSION_NEW_COMMAND] as const;

function bareName(name: string): string {
  return name.startsWith('/') ? name.slice(1) : name;
}

/** Append session commands the upstream engine list does not already have. */
export function mergeShepawSessionCommands<T extends { name: string }>(
  existing: readonly T[],
): Array<T | ShepawSessionCommand> {
  const names = new Set(existing.map((c) => bareName(c.name)));
  const missing = ALL.filter((c) => !names.has(c.name));
  if (missing.length === 0) return [...existing];
  return [...existing, ...missing];
}
