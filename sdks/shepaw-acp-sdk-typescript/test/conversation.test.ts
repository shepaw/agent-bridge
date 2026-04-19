import { describe, expect, it } from 'vitest';

import { ConversationManager } from '../src/conversation.js';

describe('ConversationManager', () => {
  it('returns an empty list for unknown sessions', () => {
    const conv = new ConversationManager();
    expect(conv.getMessages('missing')).toEqual([]);
  });

  it('records user and assistant messages in order', () => {
    const conv = new ConversationManager();
    conv.addUserMessage('s1', 'hello');
    conv.addAssistantMessage('s1', 'hi there');
    expect(conv.getMessages('s1')).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]);
  });

  it('trims history to maxHistory*2 messages', () => {
    const conv = new ConversationManager({ maxHistory: 2 });
    for (let i = 0; i < 5; i++) {
      conv.addUserMessage('s1', `u${i}`);
      conv.addAssistantMessage('s1', `a${i}`);
    }
    const msgs = conv.getMessages('s1');
    // cap = 2 * 2 = 4
    expect(msgs).toHaveLength(4);
    expect(msgs[0]).toEqual({ role: 'user', content: 'u3' });
    expect(msgs[3]).toEqual({ role: 'assistant', content: 'a4' });
  });

  it('rollback pops trailing assistant + user pair', () => {
    const conv = new ConversationManager();
    conv.addUserMessage('s1', 'hi');
    conv.addAssistantMessage('s1', 'hello');
    expect(conv.rollback('s1')).toBe(true);
    expect(conv.getMessages('s1')).toEqual([]);
  });

  it('rollback on empty session returns false', () => {
    const conv = new ConversationManager();
    expect(conv.rollback('missing')).toBe(false);
  });

  it('initializeSession only populates an empty session', () => {
    const conv = new ConversationManager();
    conv.initializeSession('s1', [
      { role: 'user', content: 'old' },
    ]);
    conv.initializeSession('s1', [{ role: 'user', content: 'overwrite?' }]);
    expect(conv.getMessages('s1')).toEqual([{ role: 'user', content: 'old' }]);
  });

  it('prependHistory prepends messages to an existing session', () => {
    const conv = new ConversationManager();
    conv.initializeSession('s1', [{ role: 'user', content: 'new' }]);
    conv.prependHistory('s1', [{ role: 'assistant', content: 'older' }]);
    expect(conv.getMessages('s1')).toEqual([
      { role: 'assistant', content: 'older' },
      { role: 'user', content: 'new' },
    ]);
  });

  it('prependHistory is a no-op for unknown sessions', () => {
    const conv = new ConversationManager();
    conv.prependHistory('missing', [{ role: 'user', content: 'x' }]);
    expect(conv.hasSession('missing')).toBe(false);
  });

  it('cleanupExpired drops stale sessions', () => {
    const conv = new ConversationManager();
    conv.addUserMessage('stale', 'old');
    // Backdate the stale session
    const lastAccess = (conv as unknown as { lastAccess: Map<string, number> }).lastAccess;
    lastAccess.set('stale', Date.now() / 1000 - 10_000);
    conv.addUserMessage('fresh', 'new');

    conv.cleanupExpired(3600);
    expect(conv.hasSession('stale')).toBe(false);
    expect(conv.hasSession('fresh')).toBe(true);
  });
});
