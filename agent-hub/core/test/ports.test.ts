import { describe, expect, it } from 'vitest';
import { allocateListenPort } from '../src/ports.js';

describe('allocateListenPort', () => {
  it('keeps the preferred port when it is free', async () => {
    const result = await allocateListenPort(18793, { probe: async () => true });
    expect(result).toEqual({ port: 18793, relocated: false });
  });

  it('moves to the next free port when preferred is busy', async () => {
    const busy = new Set([18793, 18794]);
    const result = await allocateListenPort(18793, {
      range: 10,
      probe: async (port) => !busy.has(port),
    });
    expect(result).toEqual({ port: 18795, relocated: true });
  });
});
