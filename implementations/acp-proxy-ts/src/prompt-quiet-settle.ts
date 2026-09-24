/**
 * A Claude prompt is finished when the model has streamed assistant text and
 * then gone silent with no tool and no permission card in flight. The CLI
 * sometimes never emits the SDK `result` / `idle` that `claude-agent-acp`
 * waits on, so `session/prompt` never returns and the hub never sends
 * `agent_done`. This is the signal to cancel that wedged prompt and close
 * the turn from the text already streamed.
 */

/** Silence required after the last update before a text-only turn is closed. */
export const PROMPT_QUIET_SETTLE_MS = 45_000;

/** How long to wait for `session/cancel` to produce `stop` before closing anyway. */
export const PROMPT_QUIET_CANCEL_GRACE_MS = 35_000;

const TERMINAL_TOOL_STATUS = new Set([
  'completed',
  'failed',
  'cancelled',
  'canceled',
]);

export interface ToolActivityUpdate {
  readonly sessionUpdate: string;
  readonly toolCallId?: string;
  readonly status?: string;
}

/** Track tool calls that have not reached a terminal status. */
export function applyToolActivity(open: Set<string>, update: ToolActivityUpdate): void {
  const id = update.toolCallId;
  if (typeof id !== 'string' || id.length === 0) return;
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') {
    return;
  }
  if (update.status !== undefined && TERMINAL_TOOL_STATUS.has(update.status)) {
    open.delete(id);
    return;
  }
  open.add(id);
}

/**
 * Close only when the phone already has assistant text and nothing is
 * waiting on a tool result or a human permission decision.
 */
export function quietSettleReady(opts: {
  readonly assistantChars: number;
  readonly streamed: boolean;
  readonly openTools: number;
  readonly permissionWaits: number;
}): boolean {
  return opts.streamed
    && opts.assistantChars > 0
    && opts.openTools === 0
    && opts.permissionWaits === 0;
}
