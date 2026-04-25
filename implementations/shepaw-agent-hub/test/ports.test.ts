import { describe, expect, it } from 'vitest';
import { createServer } from 'node:net';

import { nextFreePort, NoFreePortError, probeBindable } from '../src/ports.js';

describe('ports', () => {
  describe('nextFreePort (with fake probe)', () => {
    it('returns start when start is free and unreserved', async () => {
      const port = await nextFreePort({
        start: 9000,
        end: 9005,
        probe: async () => true,
      });
      expect(port).toBe(9000);
    });

    it('skips reserved ports', async () => {
      const port = await nextFreePort({
        start: 9000,
        end: 9005,
        reserved: [9000, 9001, 9002],
        probe: async () => true,
      });
      expect(port).toBe(9003);
    });

    it('skips occupied ports', async () => {
      // 9000 and 9001 "bound"; 9002 free.
      const occupied = new Set([9000, 9001]);
      const port = await nextFreePort({
        start: 9000,
        end: 9005,
        probe: async (p) => !occupied.has(p),
      });
      expect(port).toBe(9002);
    });

    it('throws NoFreePortError when range exhausted', async () => {
      await expect(
        nextFreePort({
          start: 9000,
          end: 9002,
          probe: async () => false,
        }),
      ).rejects.toBeInstanceOf(NoFreePortError);
    });

    it('rejects invalid range', async () => {
      await expect(nextFreePort({ start: 0 })).rejects.toThrow(/Invalid start/);
      await expect(nextFreePort({ start: 100, end: 50 })).rejects.toThrow(/Invalid end/);
      await expect(nextFreePort({ start: 70000 })).rejects.toThrow(/Invalid start/);
    });
  });

  describe('probeBindable (real socket)', () => {
    it('returns true for a free port', async () => {
      // Pick an arbitrary high port; if it happens to be in use the test retries.
      // Node's "listen on port 0" is the proper pattern to get a guaranteed-free
      // port, then we close it and re-probe.
      const ephemeral = await new Promise<number>((resolve, reject) => {
        const s = createServer();
        s.listen(0, '127.0.0.1', () => {
          const port = (s.address() as { port: number }).port;
          s.close((err) => (err ? reject(err) : resolve(port)));
        });
        s.on('error', reject);
      });
      const ok = await probeBindable(ephemeral);
      expect(ok).toBe(true);
    });

    it('returns false for a port we hold', async () => {
      const server = createServer();
      const port = await new Promise<number>((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => {
          resolve((server.address() as { port: number }).port);
        });
        server.on('error', reject);
      });
      try {
        const ok = await probeBindable(port);
        expect(ok).toBe(false);
      } finally {
        server.close();
      }
    });
  });
});
