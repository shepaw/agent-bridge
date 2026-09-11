/**
 * Env that turns a Hub-spawned gateway into a store client.
 *
 * Peer HTTP (`/api/v1/*`) lives on the same port as `/peer/ws`. The Shepaw
 * desktop app occupies 18792, so Hub defaults to 18793 — the gateway must
 * be told that port or `SHEPAW_PEER_STORE=1` would hit the App (or nothing).
 *
 * Engines then get the `shepaw store` PATH shim + peer-store MCP. This is
 * not ACP `hub.cli.execute` (that path is App ↔ remote ACP only).
 */

import { DEFAULT_PEER_PORT, type HubConfig } from '../config.js';

export function hubStoreClientEnv(
  cfg: Pick<HubConfig, 'peer'>,
): Record<string, string> {
  const port = cfg.peer?.port ?? DEFAULT_PEER_PORT;
  const host = '127.0.0.1';
  return {
    SHEPAW_PEER_STORE: '1',
    SHEPAW_PEER_HOST: host,
    SHEPAW_PEER_PORT: String(port),
    SHEPAW_HUB_STORE_URL: `http://${host}:${port}`,
  };
}
