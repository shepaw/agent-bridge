import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  ACP_ENGINES,
  getBuiltinEngineSpec,
  getEngineSpec,
  isAcpEngineId,
  isBuiltinEngineId,
  listBuiltinEngineIds,
  listEngineIds,
  resolveEngineSpec,
  spawnCommand,
} from '../src/engines.js';
import { mapSessionUpdate } from '../src/session-mapper.js';

describe('engines', () => {
  it('lists all supported agents', () => {
    const ids = listBuiltinEngineIds();
    expect(ids).toContain('claude-code');
    expect(ids).toContain('codebuddy');
    expect(ids).toContain('codex');
    expect(ids).toContain('cursor');
    expect(ids).toContain('kimi');
    expect(ids.length).toBe(Object.keys(ACP_ENGINES).length);
  });

  it('resolves custom engine via acp-command override', () => {
    const spec = resolveEngineSpec('tclaude', {
      acpCommand: 'npx -y @agentclientprotocol/claude-agent-acp@latest',
      displayName: 'TClaude',
    });
    expect(spec.id).toBe('tclaude');
    expect(spec.command).toBe('npx');
  });

  it('spawnCommand resolves installed Cursor CLI at spawn time', () => {
    const spec = getBuiltinEngineSpec('cursor');
    const { command } = spawnCommand(spec);
    const localAgent = join(homedir(), '.local', 'bin', 'agent');
    if (existsSync(localAgent)) {
      expect(command).toBe(localAgent);
    } else if (existsSync('/opt/homebrew/bin/cursor-agent')) {
      expect(command).toBe('/opt/homebrew/bin/cursor-agent');
    } else {
      expect(command).toBe('agent');
    }
  });

  it('spawnCommand adds Cursor run mode flags from PAW_ACP_SESSION_MODE', () => {
    const spec = getBuiltinEngineSpec('cursor');
    expect(spawnCommand(spec, { PAW_ACP_SESSION_MODE: 'auto-review' }).args[0]).toBe('--auto-review');
    expect(spawnCommand(spec, { PAW_ACP_SESSION_MODE: 'unrestricted' }).args[0]).toBe('--force');
    expect(spawnCommand(spec, { PAW_ACP_SESSION_MODE: 'allowlist' }).args).toEqual(['acp']);
  });

  it('validates engine ids', () => {
    expect(isAcpEngineId('claude-code')).toBe(true);
    expect(isAcpEngineId('unknown')).toBe(false);
  });

  it('uses npx.cmd on Windows', () => {
    const spec = getBuiltinEngineSpec('claude-code');
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

  it('streams tool_call_update status so post-approval progress is visible', async () => {
    const chunks: string[] = [];
    const ctx = {
      sendText: async (text: string) => {
        chunks.push(text);
      },
      sendMessageMetadata: async () => {},
    };

    await mapSessionUpdate(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc_1',
        status: 'completed',
        title: 'Bash',
        kind: 'execute',
      },
      ctx as never,
    );

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('[completed] Bash');
  });
});
