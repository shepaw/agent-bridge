/**
 * Entry point for the device-level peer service daemon.
 *
 * Spawned detached by `startPeerService` (peer-process.ts). Loads the peer
 * config (host/port) from hub.json, starts the `/peer/ws` Noise IK responder
 * server, and runs until SIGTERM/SIGINT. Pairing codes are read from
 * `peer-pairing.json` (written by `peer pair`), so no control channel needed.
 */

import { PeerServer } from './peer-server.js';

async function main(): Promise<void> {
  const server = new PeerServer({
    log: (line) => console.log(`${new Date().toISOString()} ${line}`),
  });

  await server.start();

  const shutdown = (signal: string): void => {
    console.log(`${new Date().toISOString()} [Peer] Received ${signal}, shutting down...`);
    server
      .stop()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(
    `${new Date().toISOString()} [Peer] Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
  );
  process.exit(1);
});
