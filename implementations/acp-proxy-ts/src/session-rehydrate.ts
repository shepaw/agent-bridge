/**
 * Rebuild conversation context when an upstream ACP session cannot be resumed
 * and we have to session/new. The app conversation id stays the same; only the
 * engine handle is new — without this, the agent greets as a blank chat.
 */

import type { ContentBlock } from '@agentclientprotocol/sdk';

export interface PriorHistoryTurn {
  readonly role: string;
  readonly content: string;
}

const MAX_TURNS = 40;
const MAX_CHARS = 60_000;

export function formatHistoryPreamble(history: ReadonlyArray<PriorHistoryTurn>): string {
  const lines: string[] = [
    'The following is the prior conversation in this session. Continue from it.',
    'Do not greet as if this is a new chat. Do not summarize unless asked.',
    '',
  ];
  let chars = 0;
  const turns = history
    .filter((t) => (t.role === 'user' || t.role === 'assistant') && t.content.trim().length > 0)
    .slice(-MAX_TURNS);
  for (const turn of turns) {
    const role = turn.role === 'assistant' ? 'Assistant' : 'User';
    const chunk = `${role}: ${turn.content.trim()}`;
    if (chars + chunk.length > MAX_CHARS) break;
    lines.push(chunk, '');
    chars += chunk.length;
  }
  lines.push('Current user message follows.');
  return lines.join('\n');
}

export function prependHistoryToPrompt(
  prompt: string | ContentBlock | ReadonlyArray<ContentBlock>,
  history: ReadonlyArray<PriorHistoryTurn>,
): ContentBlock[] {
  const rest: ContentBlock[] = Array.isArray(prompt)
    ? [...prompt]
    : typeof prompt === 'string'
      ? [{ type: 'text', text: prompt }]
      : [prompt];
  const turns = history.filter(
    (t) => (t.role === 'user' || t.role === 'assistant') && t.content.trim().length > 0,
  );
  if (turns.length === 0) return rest;
  return [{ type: 'text', text: formatHistoryPreamble(turns) }, ...rest];
}
