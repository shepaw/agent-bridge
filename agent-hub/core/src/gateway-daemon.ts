/**
 * Entry point for the device-level tunnel router daemon.
 *
 * Spawned detached by `startGatewayRouter` (gateway-process.ts). Reads the
 * shared channel tunnel + router port from `hub.json`, opens one reverse
 * tunnel to the Channel Service, and dispatches incoming connections to the
 * right agent's loopback port. Runs until it receives SIGTERM/SIGINT.
 */

import { ChannelTunnelConfig } from 'shepaw-acp-sdk';

import { DEFAULT_ROUTER_HOST, DEFAULT_ROUTER_PORT, loadOrCreateHubConfig } from './config.js';
import { GatewayTunnelRouter } from './tunnel-router.js';

async function main(): Promise<void> {
  const cfg = loadOrCreateHubConfig();
  const gw = cfg.gateway;
  const routerHost = gw?.routerHost ?? DEFAULT_ROUTER_HOST;
  const routerPort = gw?.routerPort ?? DEFAULT_ROUTER_PORT;

  let tunnel: ChannelTunnelConfig | undefined;
  if (gw?.tunnel !== undefined) {
    tunnel = await ChannelTunnelConfig.createWithAliasLookup({
      serverUrl: gw.tunnel.serverUrl,
      channelId: gw.tunnel.channelId,
      secret: gw.tunnel.secret,
    });
  }

  const router = new GatewayTunnelRouter({
    routerHost,
    routerPort,
    tunnel,
    onLog: (line) => console.log(`${new Date().toISOString()} ${line}`),
  });

  await router.start();

  const shutdown = (signal: string) => {
    console.log(`${new Date().toISOString()} [Router] Received ${signal}, shutting down...`);
    router
      .stop()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(`${new Date().toISOString()} [Router] Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
