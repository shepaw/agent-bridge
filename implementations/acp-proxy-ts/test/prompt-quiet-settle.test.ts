import { describe, expect, it } from 'vitest';
import {
  applyToolActivity,
  quietSettleReady,
} from '../src/prompt-quiet-settle.js';

describe('quietSettleReady', () => {
  const ready = {
    assistantChars: 12,
    streamed: true,
    openTools: 0,
    permissionWaits: 0,
  };

  it('closes a streamed reply with nothing in flight', () => {
    expect(quietSettleReady(ready)).toBe(true);
  });

  it('waits while a tool or a permission card is open', () => {
    expect(quietSettleReady({ ...ready, openTools: 1 })).toBe(false);
    expect(quietSettleReady({ ...ready, permissionWaits: 1 })).toBe(false);
  });

  it('does not close before assistant text has been streamed', () => {
    expect(quietSettleReady({ ...ready, streamed: false })).toBe(false);
    expect(quietSettleReady({ ...ready, assistantChars: 0 })).toBe(false);
  });
});

describe('applyToolActivity', () => {
  it('holds the tool until a terminal status', () => {
    const open = new Set<string>();
    applyToolActivity(open, { sessionUpdate: 'tool_call', toolCallId: 't1', status: 'pending' });
    expect(open.has('t1')).toBe(true);
    applyToolActivity(open, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
    expect(open.size).toBe(0);
  });

  it('ignores updates that are not tool calls', () => {
    const open = new Set<string>();
    applyToolActivity(open, { sessionUpdate: 'agent_message_chunk' });
    expect(open.size).toBe(0);
  });
});
