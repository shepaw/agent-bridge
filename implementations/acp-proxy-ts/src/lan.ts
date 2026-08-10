/**
 * LAN address detection for pairing URLs shown to phones on the same network.
 * Mirrors agent-hub/core/src/network.ts — kept local so the gateway package
 * stays free of hub dependencies.
 */

import { networkInterfaces } from 'node:os';

/** Pick the first non-internal IPv4 address on a common LAN interface. */
export function detectLanIPv4(): string | undefined {
  const ifaces = networkInterfaces();
  const prefer = ['en0', 'en1', 'wlan0', 'eth0'];
  const names = [...prefer, ...Object.keys(ifaces).filter((n) => !prefer.includes(n))];

  for (const name of names) {
    const addrs = ifaces[name];
    if (addrs === undefined) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address;
      }
    }
  }
  return undefined;
}
