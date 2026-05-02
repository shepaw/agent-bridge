/**
 * Step 5 fs.watch + broadcast + snapshot dedup tests.
 *
 * These exercise ClaudeCodeAgent's command-watching machinery directly
 * without standing up a WebSocket server — we subclass the agent to
 * expose the protected broadcast and observe the calls via a spy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SlashCommandInfo } from 'shepaw-acp-sdk';

import { ClaudeCodeAgent } from '../src/agent.js';

// Silence the SDK subprocess — init() doesn't call query() directly, but
// agents pull in the SDK import at module load time.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true }) }) }) }));

class SpyAgent extends ClaudeCodeAgent {
  readonly broadcasts: SlashCommandInfo[][] = [];

  override async broadcastCommandsChanged(commands: SlashCommandInfo[]): Promise<void> {
    this.broadcasts.push(commands);
  }
}

let dir: string;
let cmdDir: string;
let agent: SpyAgent | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'shepaw-cmd-watch-'));
  cmdDir = join(dir, '.claude', 'commands');
  await mkdir(cmdDir, { recursive: true });
});

afterEach(async () => {
  if (agent !== undefined) {
    await agent.close().catch(() => undefined);
    agent = undefined;
  }
  await rm(dir, { recursive: true, force: true });
});

function makeAgent(): SpyAgent {
  return new SpyAgent({
    name: 'Spy',
    cwd: dir,
    commandsDirs: [{ path: cmdDir, scope: 'project' }],
    sessionStoreOptions: { path: join(dir, 'sessions.json') },
    pendingMarkerOptions: { path: join(dir, 'pending.json') },
    patternRuleStoreOptions: {
      sessionRulesPath: join(dir, 'session-rules.json'),
      globalRulesPath: join(dir, 'global-rules.json'),
    },
  });
}

async function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('ClaudeCodeAgent — fs.watch + snapshot dedup', () => {
  it('broadcasts on file add with merged metadata', async () => {
    agent = makeAgent();
    await agent.init();
    // init seeds the snapshot but the initial scan found nothing, so no
    // pre-broadcast should have happened.
    expect(agent.broadcasts).toHaveLength(0);

    await writeFile(
      join(cmdDir, 'plan.md'),
      '---\ndescription: Plan it\nargument-hint: <ticket>\n---\n',
      'utf-8',
    );

    // 200ms debounce + fs event delay.
    await wait(500);

    expect(agent.broadcasts.length).toBeGreaterThanOrEqual(1);
    const latest = agent.broadcasts[agent.broadcasts.length - 1];
    expect(latest).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'plan',
          description: 'Plan it',
          argument_hint: '<ticket>',
          scope: 'project',
          source: 'filesystem',
        }),
      ]),
    );
  });

  it('suppresses duplicate broadcasts when snapshot is unchanged', async () => {
    await writeFile(
      join(cmdDir, 'plan.md'),
      '---\ndescription: d\n---\n',
      'utf-8',
    );
    agent = makeAgent();
    await agent.init();

    const baseline = agent.broadcasts.length;

    // Re-write identical content — fs.watch fires, but hash unchanged.
    await writeFile(
      join(cmdDir, 'plan.md'),
      '---\ndescription: d\n---\n',
      'utf-8',
    );
    await wait(500);

    expect(agent.broadcasts.length).toBe(baseline);
  });

  it('broadcasts on file remove', async () => {
    await writeFile(join(cmdDir, 'temp.md'), '---\ndescription: t\n---\n', 'utf-8');
    agent = makeAgent();
    await agent.init();
    const baseline = agent.broadcasts.length;

    await unlink(join(cmdDir, 'temp.md'));
    await wait(500);

    expect(agent.broadcasts.length).toBe(baseline + 1);
    const latest = agent.broadcasts[agent.broadcasts.length - 1];
    expect(latest.find((c) => c.name === 'temp')).toBeUndefined();
  });

  it('close() stops watchers and pending timers', async () => {
    agent = makeAgent();
    await agent.init();
    await agent.close();
    const baseline = agent.broadcasts.length;

    // Any further file event should not trigger a broadcast.
    await writeFile(join(cmdDir, 'late.md'), '---\ndescription: l\n---\n', 'utf-8');
    await wait(500);

    expect(agent.broadcasts.length).toBe(baseline);
    agent = undefined; // prevent afterEach from double-closing
  });
});
