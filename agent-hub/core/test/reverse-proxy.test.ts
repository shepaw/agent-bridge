/**
 * Reverse-proxy exposure coverage:
 *   - Endpoint derivation helpers (`gateway-endpoints.ts`) resolve the
 *     `wss://<publicBase><prefix>/peer/ws` + `/p/<id>/acp/ws` forms, with the
 *     shared Channel tunnel always winning when both exposures are set.
 *   - `validateReverseProxyInput` (strict, write paths) rejects ws(s) origins,
 *     malformed path prefixes, and missing values.
 *   - `parseReverseProxyConfig` (lenient, hub.json load) tolerates hand edits
 *     and a missing leading `/` on `pathPrefix`.
 */

import { describe, expect, it } from 'vitest';

import {
  parseReverseProxyConfig,
  validateReverseProxyInput,
} from '../src/config.js';
import {
  gatewayAcpWsBase,
  hasGatewayExposure,
  peerChannelWsUrl,
  reverseProxyPeerWsUrl,
  reverseProxyWsBase,
  tunnelAcpWsBase,
  wsScheme,
} from '../src/gateway-endpoints.js';

const RP = { publicBaseUrl: 'https://agents.example.com', pathPrefix: '/hub-a' };
const TUNNEL = {
  serverUrl: 'https://channel.example.com',
  channelId: 'ch_abc123',
  secret: 'super-secret-hmac-key',
};

describe('wsScheme / endpoint derivation', () => {
  it('swaps http(s) origins to ws(s) and strips a trailing slash', () => {
    expect(wsScheme('https://agents.example.com/')).toBe('wss://agents.example.com');
    expect(wsScheme('http://agents.example.com')).toBe('ws://agents.example.com');
  });

  it('builds the reverse-proxy base from publicBaseUrl + pathPrefix', () => {
    const cfg = { gateway: { reverseProxy: RP } };
    expect(reverseProxyWsBase(cfg)).toBe('wss://agents.example.com/hub-a');
    expect(reverseProxyPeerWsUrl(cfg)).toBe('wss://agents.example.com/hub-a/peer/ws');
  });

  it('omits pathPrefix when the entry exposes the origin root', () => {
    const cfg = { gateway: { reverseProxy: { publicBaseUrl: 'https://agents.example.com' } } };
    expect(reverseProxyWsBase(cfg)).toBe('wss://agents.example.com');
    expect(reverseProxyPeerWsUrl(cfg)).toBe('wss://agents.example.com/peer/ws');
  });

  it('lets the shared tunnel win for the effective base when both are set', () => {
    const cfg = { gateway: { tunnel: TUNNEL, reverseProxy: RP } };
    expect(tunnelAcpWsBase(cfg)).toBe('wss://channel.example.com/proxy/ch_abc123');
    expect(reverseProxyWsBase(cfg)).toBe('wss://agents.example.com/hub-a');
    // The effective (pairing) base is the tunnel; the proxy-specific peer URL
    // still reflects what THIS exposure would serve on its own.
    expect(gatewayAcpWsBase(cfg)).toBe('wss://channel.example.com/proxy/ch_abc123');
    expect(peerChannelWsUrl(cfg)).toBe('wss://channel.example.com/proxy/ch_abc123/peer/ws');
    expect(reverseProxyPeerWsUrl(cfg)).toBe('wss://agents.example.com/hub-a/peer/ws');
  });

  it('treats reverse-proxy-only config as a remote exposure', () => {
    expect(hasGatewayExposure({ gateway: { reverseProxy: RP } })).toBe(true);
    expect(hasGatewayExposure({ gateway: { tunnel: TUNNEL } })).toBe(true);
    expect(hasGatewayExposure({ gateway: {} })).toBe(false);
    expect(hasGatewayExposure({})).toBe(false);
  });
});

describe('validateReverseProxyInput (strict)', () => {
  it('requires a non-empty publicBaseUrl', () => {
    expect(() => validateReverseProxyInput({})).toThrowError(/required/i);
    expect(() => validateReverseProxyInput({ publicBaseUrl: '   ' })).toThrowError(/required/i);
    expect(() => validateReverseProxyInput({ publicBaseUrl: 'ws://agents.example.com' })).toThrowError(/http/i);
  });

  it('rejects ws:// and wss:// origins', () => {
    expect(() => validateReverseProxyInput({ publicBaseUrl: 'ws://agents.example.com' })).toThrowError(/http/i);
    expect(() => validateReverseProxyInput({ publicBaseUrl: 'wss://agents.example.com' })).toThrowError(/http/i);
  });

  it('normalizes trailing slashes off the origin', () => {
    expect(validateReverseProxyInput({ publicBaseUrl: 'https://agents.example.com/' })).toEqual({
      publicBaseUrl: 'https://agents.example.com',
    });
  });

  it('normalizes a path prefix (trailing slash stripped, empty dropped)', () => {
    expect(validateReverseProxyInput({ publicBaseUrl: 'https://a.example.com', pathPrefix: '/hub-a/' })).toEqual({
      publicBaseUrl: 'https://a.example.com',
      pathPrefix: '/hub-a',
    });
    expect(validateReverseProxyInput({ publicBaseUrl: 'https://a.example.com', pathPrefix: '/' })).toEqual({
      publicBaseUrl: 'https://a.example.com',
    });
    expect(validateReverseProxyInput({ publicBaseUrl: 'https://a.example.com', pathPrefix: '  ' })).toEqual({
      publicBaseUrl: 'https://a.example.com',
    });
  });

  it('requires a leading "/" on pathPrefix and rejects ?/#/whitespace', () => {
    expect(() =>
      validateReverseProxyInput({ publicBaseUrl: 'https://a.example.com', pathPrefix: 'hub-a' }),
    ).toThrowError(/must start with/i);
    expect(() =>
      validateReverseProxyInput({ publicBaseUrl: 'https://a.example.com', pathPrefix: '/hub a' }),
    ).toThrowError(/must not contain/i);
    expect(() =>
      validateReverseProxyInput({ publicBaseUrl: 'https://a.example.com', pathPrefix: '/hub?a' }),
    ).toThrowError(/must not contain/i);
  });
});

describe('parseReverseProxyConfig (lenient)', () => {
  it('returns undefined for malformed or missing entries', () => {
    expect(parseReverseProxyConfig(undefined)).toBeUndefined();
    expect(parseReverseProxyConfig({ publicBaseUrl: 'not-a-url' })).toBeUndefined();
    expect(parseReverseProxyConfig({ publicBaseUrl: 'ws://agents.example.com' })).toBeUndefined();
    expect(parseReverseProxyConfig({ publicBaseUrl: 42 })).toBeUndefined();
    expect(parseReverseProxyConfig('x')).toBeUndefined();
  });

  it('tolerates a missing leading "/" and trailing slashes on pathPrefix', () => {
    expect(
      parseReverseProxyConfig({ publicBaseUrl: 'https://agents.example.com/', pathPrefix: 'hub-a/' }),
    ).toEqual({ publicBaseUrl: 'https://agents.example.com', pathPrefix: '/hub-a' });
  });
});
