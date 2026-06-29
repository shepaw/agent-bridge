import { describe, expect, it } from 'vitest';

import {
  ACP_ENGINES,
  getEngineSpec,
  isAcpEngineId,
  listEngineIds,
  spawnCommand,
} from '../src/engines.js';
import { mapSessionUpdate } from '../src/session-mapper.js';

describe('engines', () => {
  it('lists all supported agents', () => {
    const ids = listEngineIds();
    expect(ids).toContain('claude-code');
    expect(ids).toContain('tclaude');
    expect(ids).toContain('codebuddy');
    expect(ids).toContain('codex');
    expect(ids).toContain('tcodex');
    expect(ids).toContain('cursor');
    expect(ids.length).toBe(Object.keys(ACP_ENGINES).length);
  });

  it('tclaude and tcodex use the same spawn command as their upstream counterparts', () => {
    expect(getEngineSpec('tclaude').args).toEqual(getEngineSpec('claude-code').args);
    expect(getEngineSpec('tcodex').args).toEqual(getEngineSpec('codex').args);
  });

  it('validates engine ids', () => {
    expect(isAcpEngineId('claude-code')).toBe(true);
    expect(isAcpEngineId('unknown')).toBe(false);
  });

  it('uses npx.cmd on Windows', () => {
    const spec = getEngineSpec('claude-code');
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(spawnCommand(spec).command).toBe('npx.cmd');
    } finally {
      Object.defineProperty(process, 'platform', { value: original });
    }
  });
});

describe('mapSessionUpdate', () => {
  it('streams agent text chunks', async () => {
    const chunks: string[] = [];
    const ctx = {
      sendText: async (text: string) => {
        chunks.push(text);
      },
      sendMessageMetadata: async () => {},
    };

    await mapSessionUpdate(
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello' },
      },
      ctx as never,
    );

    expect(chunks).toEqual(['Hello']);
  });
});
