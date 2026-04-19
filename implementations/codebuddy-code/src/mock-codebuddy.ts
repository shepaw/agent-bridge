/**
 * Scripted replacement for `@tencent-ai/agent-sdk`'s `query()`
 * so the gateway can run end-to-end without a CodeBuddy API key.
 *
 * The mock reads the user's message and branches by keyword:
 *
 *   "help"           → prints the list of scenarios
 *   "run" / "bash"   → calls canUseTool → gateway fires
 *                       ui.actionConfirmation to the phone (non-blocking)
 *                       and DENYs this turn; when the user taps "Allow",
 *                       the *next* "bash" message hits the approval cache
 *                       and the mock emits the tool output.
 *   "ask"            → calls canUseTool with AskUserQuestion → gateway
 *                       fires ui.form (radio_group / checkbox_group) and
 *                       DENYs; user submits the form as a plain-text chat
 *                       message on the next turn.
 *   "slow"           → streams a sentence one word at a time so you can
 *                       watch the text chunks arrive
 *   "error"          → throws, to test the task.error path
 *   anything else    → plain `[mock] You said: "…"` echo
 *
 * Aborting (agent.cancelTask) is honoured between messages and inside
 * the `slow` sleep.
 */

import { randomUUID } from 'node:crypto';

import type { Options } from '@tencent-ai/agent-sdk';

// ── Public API ───────────────────────────────────────────────────────

/** Signature subset the gateway actually calls. */
export type QueryFn = (params: {
  prompt: string | AsyncIterable<unknown>;
  options?: Options;
}) => AsyncIterable<Record<string, unknown>>;

export interface MockQueryOptions {
  /** Delay between chunks when streaming (scenario "slow"). Default 80 ms. */
  chunkDelayMs?: number;
  /** Session id for the `system.init` event. Auto-generated if omitted. */
  sessionId?: string;
}

/** Build a `query`-compatible mock function. */
export function createMockQuery(opts: MockQueryOptions = {}): QueryFn {
  const chunkDelayMs = opts.chunkDelayMs ?? 80;
  const sessionId = opts.sessionId ?? `mock-${randomUUID()}`;

  return function mockQuery(params) {
    return generate(params, sessionId, chunkDelayMs);
  };
}

/** Default instance — convenient for the CLI `--mock` flag. */
export const mockQuery: QueryFn = createMockQuery();

// ── Scenario engine ──────────────────────────────────────────────────

async function* generate(
  params: { prompt: string | AsyncIterable<unknown>; options?: Options },
  sessionId: string,
  chunkDelayMs: number,
): AsyncGenerator<Record<string, unknown>, void> {
  const signal = params.options?.abortController?.signal;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const canUseTool = params.options?.canUseTool as any;

  // 1. Announce the session to the gateway so SessionStore records it.
  yield systemInit(sessionId);

  // 2. Parse the user message.
  const userText = await extractPromptText(params.prompt);
  const kw = userText.toLowerCase();

  // 3. Route to a scripted scenario.
  if (kw.includes('help')) {
    yield assistantText(HELP_TEXT);
  } else if (kw.includes('error')) {
    yield assistantText('About to throw a deliberate error …');
    throw new Error('[mock] deliberate error for testing');
  } else if (kw.includes('slow')) {
    const words = 'This is a slow streaming demo so you can watch each chunk land on the phone.'.split(' ');
    for (const word of words) {
      if (signal?.aborted === true) return;
      yield assistantText(word + ' ');
      await sleep(chunkDelayMs, signal);
    }
  } else if (kw.includes('bash') || kw.includes('run')) {
    yield assistantText("Sure — I'll run a demo command.");
    if (canUseTool !== undefined) {
      const decision = await canUseTool(
        'Bash',
        { command: 'echo "hello from mock CodeBuddy"' },
        { signal: signal ?? new AbortController().signal, toolUseID: `tu_${randomUUID().slice(0, 8)}` },
      );
      if (decision?.behavior === 'allow') {
        yield assistantToolUse('Bash', { command: 'echo "hello from mock CodeBuddy"' });
        yield assistantText('\n(mock output)\n  hello from mock CodeBuddy\n');
      } else {
        // The gateway denied this turn because no approval is cached yet;
        // a ui.actionConfirmation is already on its way to the phone. Tell
        // the user what's happening so the DENY turn doesn't feel broken.
        yield assistantText(
          '\nI\'ve sent a confirmation to your phone. Reply "allow" (or "同意") to continue, or "deny" / "拒绝" to cancel.',
        );
      }
    } else {
      yield assistantText('(no canUseTool wired — nothing to approve.)');
    }
  } else if (kw.includes('ask') || kw.includes('question')) {
    yield assistantText('Let me ask a clarifying question.');
    if (canUseTool !== undefined) {
      const decision = await canUseTool(
        'AskUserQuestion',
        {
          questions: [
            {
              question: 'Which language do you prefer?',
              header: 'Lang',
              options: [
                { label: 'TypeScript', description: 'types for days' },
                { label: 'Python', description: 'classic' },
                { label: 'Rust', description: 'no GC' },
              ],
              multiSelect: false,
            },
          ],
        },
        { signal: signal ?? new AbortController().signal, toolUseID: `tu_${randomUUID().slice(0, 8)}` },
      );
      if (decision?.behavior === 'allow') {
        const answers = (decision.updatedInput as { answers?: Record<string, string> }).answers ?? {};
        yield assistantText(`\nGreat — you picked: ${JSON.stringify(answers, null, 2)}`);
      } else {
        // Under the non-blocking protocol, AskUserQuestion always denies
        // the current turn; the form is on the phone and the user's reply
        // will arrive as a fresh agent.chat message.
        yield assistantText(
          "\nI've sent a form to your phone. Fill it in and send it — your answer will come back as your next chat message.",
        );
      }
    }
  } else {
    yield assistantText(
      `[mock] You said: "${userText}"\n\nType "help" to see what this mock can simulate.`,
    );
  }

  yield resultSuccess(sessionId);
}

const HELP_TEXT = `[mock] CodeBuddy Code mock agent — try these in your next message:

• "hello"         — plain text echo
• "run bash"      — triggers a Bash approval (ui.actionConfirmation).
                    Reply "allow" (or "同意") on the NEXT message to run it;
                    reply "deny" / "拒绝" to cancel.
• "ask me"        — triggers AskUserQuestion (ui.form with radio_group).
                    Fill the form and hit Submit — your answer arrives as
                    a new chat message.
• "slow"          — streams a sentence word-by-word so you can see chunks arrive
• "error"         — throws inside the mock (exercises the task.error path)

Aborting a running task (cancel from the app) works in every scenario.`;

// ── SDK message shapes (only the fields the gateway actually reads) ──

function systemInit(sessionId: string): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    cwd: process.cwd(),
    tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'AskUserQuestion'],
    mcp_servers: [],
    model: 'codebuddy-mock',
    codebuddy_code_version: '0.0.0-mock',
  };
}

function assistantText(text: string): Record<string, unknown> {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
    parent_tool_use_id: null,
    session_id: '',
  };
}

function assistantToolUse(
  name: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: `tu_${randomUUID().slice(0, 8)}`,
          name,
          input,
        },
      ],
    },
    parent_tool_use_id: null,
    session_id: '',
  };
}

function resultSuccess(sessionId: string): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 0,
    num_turns: 1,
    total_cost_usd: 0,
    session_id: sessionId,
  };
}

// ── helpers ──────────────────────────────────────────────────────────

async function extractPromptText(
  prompt: string | AsyncIterable<unknown>,
): Promise<string> {
  if (typeof prompt === 'string') return prompt;
  for await (const msg of prompt) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = msg as any;
    const content = m?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      for (const block of content) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const b = block as any;
        if (b?.type === 'text' && typeof b.text === 'string') return b.text;
      }
    }
    return '';
  }
  return '';
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
