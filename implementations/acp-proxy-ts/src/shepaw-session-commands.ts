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

export const SESSION_NEW_EXPAND_OPEN = '[session-new]';
export const SESSION_NEW_EXPAND_CLOSE = '[/session-new]';

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

export function isSessionSlashExpanded(text: string): boolean {
  return (
    text.includes(SESSION_NEW_EXPAND_OPEN) &&
    text.includes(SESSION_NEW_EXPAND_CLOSE)
  );
}

export function parseInvokedSessionCommand(
  raw: string,
): 'session-new' | 'group-session-new' | null {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('/')) return null;
  const space = trimmed.search(/\s/);
  const name = bareName(space === -1 ? trimmed.slice(1) : trimmed.slice(1, space));
  if (name === SESSION_NEW_COMMAND.name) return 'session-new';
  if (name === GROUP_SESSION_NEW_COMMAND.name) return 'group-session-new';
  return null;
}

function modelInstruction(isGroup: boolean): string {
  if (isGroup) {
    return [
      'The user invoked /group-session-new. Understand the current conversation intent, compress durable context into a handoff, then run:',
      '',
      'shepaw chat group session create --reason <topic_shift|post_delivery|noise_reduction|context_too_long|agent_memory_reset|parallel_track|user_requested> --handoff-json \'{"task":{"user_goal":"...","acceptance_criteria":["..."],"status":"in_progress"}}\'',
      '',
      'Honor any flags the user already typed after the command. After the command succeeds, a switch card appears for the user to confirm. Do not assume they switched; continue here until they open the new session.',
    ].join('\n');
  }
  return [
    'The user invoked /session-new. Understand the current conversation intent, compress durable context into a handoff summary, then run:',
    '',
    'shepaw chat session create --reason <topic_shift|post_delivery|noise_reduction|context_too_long|agent_memory_reset|parallel_track|user_requested> --summary "<compressed key points>"',
    '',
    'Honor any flags the user already typed after the command. After the command succeeds, a switch card appears for the user to confirm. Do not assume they switched; continue here until they open the new session.',
  ].join('\n');
}

/** Expand `/session-new` for the engine prompt. Idempotent if already expanded. */
export function expandSessionSlashPrompt(raw: string): string {
  if (isSessionSlashExpanded(raw)) return raw;
  const name = parseInvokedSessionCommand(raw);
  if (!name) return raw;
  const instruction = modelInstruction(name === 'group-session-new');
  return `${raw}\n\n${SESSION_NEW_EXPAND_OPEN}\n${instruction}\n${SESSION_NEW_EXPAND_CLOSE}`;
}
