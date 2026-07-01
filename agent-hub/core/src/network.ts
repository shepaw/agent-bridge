/**
 * Resolve a host string suitable for URLs shown to remote clients (phones, etc.).
 * Binds like 0.0.0.0 / :: are valid for servers but unusable in pairing URLs.
 */

import { networkInterfaces } from 'node:os';

const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '']);

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

/** Map server bind host to a client-reachable hostname/IP. */
export function resolvePublicHost(bindHost: string): string {
  if (!WILDCARD_HOSTS.has(bindHost)) return bindHost;
  return detectLanIPv4() ?? '127.0.0.1';
}
