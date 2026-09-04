/**
 * Single source of truth for deriving a hub's public gateway endpoints.
 *
 * A hub can be reachable from outside the LAN two ways:
 *   1. Shared Channel — `gateway.tunnel` → `<wss://server>/proxy/<channelId>`.
 *   2. Self-managed reverse proxy — `gateway.reverseProxy` →
 *      `wsScheme(publicBaseUrl) + pathPrefix` (nginx forwards to the local
 *      tunnel router; no Shepaw cloud relay).
 *
 * A hub may configure both; the shared Channel always wins when both are
 * present because the tunnel router's inbound `/proxy/…` path is what the
 * Channel Service forwards to. All pairing / catalog URL builders (peer QR,
 * `shepaw://pair`, ACP catalog) route through this module so the precedence
 * rule lives in exactly one place.
 *
 * Naming: "...AcpWsBase" is the prefix that `/p/<instanceId>/acp/ws` (and
 * `/peer/ws`) hang off — i.e. the external base WITHOUT the trailing segment.
 */

import type { GatewayConfig, HubConfig } from './config.js';

/** A hub is LAN-only (no router needed) unless one of these is present. */
type GatewayExposureCfg = { gateway?: Pick<GatewayConfig, 'tunnel' | 'reverseProxy'> };

/** https→wss / http→ws scheme swap + trailing `/` strip. Input is http(s). */
export function wsScheme(url: string): string {
  return url
    .replace(/\/+$/, '')
    .replace(/^https:\/\//i, 'wss://')
    .replace(/^http:\/\//i, 'ws://');
}

/** `wss://<server>/proxy/<channelId>` base for the shared gateway channel. */
export function tunnelAcpWsBase(cfg: GatewayExposureCfg): string | undefined {
  const t = cfg.gateway?.tunnel;
  if (t === undefined) return undefined;
  return `${wsScheme(t.serverUrl)}/proxy/${t.channelId}`;
}

/** `ws(s)://<publicBaseUrl><pathPrefix>` base for the self-managed proxy. */
export function reverseProxyWsBase(cfg: GatewayExposureCfg): string | undefined {
  const rp = cfg.gateway?.reverseProxy;
  if (rp === undefined) return undefined;
  const base = wsScheme(rp.publicBaseUrl);
  const prefix = rp.pathPrefix ?? '';
  return prefix.length > 0 ? `${base}${prefix}` : base;
}

/** Effective external base for `/p/<id>/acp/ws` + `/peer/ws`: tunnel first. */
export function gatewayAcpWsBase(cfg: GatewayExposureCfg): string | undefined {
  return tunnelAcpWsBase(cfg) ?? reverseProxyWsBase(cfg);
}

/** Whether any remote (non-LAN) exposure is configured (channel or proxy). */
export function hasGatewayExposure(cfg: GatewayExposureCfg): boolean {
  return cfg.gateway?.tunnel !== undefined || cfg.gateway?.reverseProxy !== undefined;
}

/** Effective WAN peer WS URL (`channel=` in the pairing QR). Undefined → LAN-only. */
export function peerChannelWsUrl(cfg: GatewayExposureCfg): string | undefined {
  const base = gatewayAcpWsBase(cfg);
  return base !== undefined ? `${base}/peer/ws` : undefined;
}

/** Peer WS entry this hub's own reverse proxy would serve (proxy-specific). */
export function reverseProxyPeerWsUrl(cfg: GatewayExposureCfg): string | undefined {
  const base = reverseProxyWsBase(cfg);
  return base !== undefined ? `${base}/peer/ws` : undefined;
}

/** Keep HubConfig import referenced (callers pass a full HubConfig). */
export type { HubConfig };
