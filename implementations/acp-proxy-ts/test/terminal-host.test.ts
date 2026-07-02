import { describe, expect, it } from 'vitest';
import type * as acp from '@agentclientprotocol/sdk';

import { TerminalHost } from '../src/terminal-host.js';

function createReq(command: string, args?: string[]): acp.CreateTerminalRequest {
  return { sessionId: 's1', command, args } as acp.CreateTerminalRequest;
}

describe('TerminalHost', () => {
  it('runs a full command line packed into `command` with empty args', async () => {
    const host = new TerminalHost();
    // This is exactly what CodeBuddy sends: the whole line in `command`.
    const { terminalId } = host.create(createReq('echo hello-shepaw'));
    const exit = await host.waitForExit({ sessionId: 's1', terminalId });
    expect(exit.exitCode).toBe(0);
    const out = host.output({ sessionId: 's1', terminalId });
    expect(out.output).toContain('hello-shepaw');
    host.disposeAll();
  });

  it('does NOT crash on a missing binary via the shell path (empty args)', async () => {
    const host = new TerminalHost();
    // Empty args → run through the shell; a missing command is reported by the
    // shell as exit 127 rather than a spawn-level crash.
    const { terminalId } = host.create(createReq('definitely-not-a-real-binary-xyz'));
    const exit = await host.waitForExit({ sessionId: 's1', terminalId });
    expect(exit.exitCode).toBe(127);
    host.disposeAll();
  });

  it('does NOT crash on a spawn error (argv form, missing binary)', async () => {
    const host = new TerminalHost();
    // argv form → shell:false → spawn emits an 'error' event. This used to be
    // unhandled and crashed the whole gateway; it must now settle as failed.
    const { terminalId } = host.create(createReq('definitely-not-a-real-binary-xyz', ['arg']));
    const exit = await host.waitForExit({ sessionId: 's1', terminalId });
    expect(exit.exitCode).toBe(127);
    expect(host.output({ sessionId: 's1', terminalId }).output).toContain('failed to run command');
    host.disposeAll();
  });

  it('runs the proper argv form when args are provided', async () => {
    const host = new TerminalHost();
    const { terminalId } = host.create(createReq('echo', ['a', 'b']));
    const exit = await host.waitForExit({ sessionId: 's1', terminalId });
    expect(exit.exitCode).toBe(0);
    expect(host.output({ sessionId: 's1', terminalId }).output).toContain('a b');
    host.disposeAll();
  });
});
