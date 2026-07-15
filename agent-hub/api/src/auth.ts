/**
 * Optional Bearer-token auth for the Hub dashboard API.
 *
 * Auth is enabled when `SHEPAW_HUB_TOKEN` (or `authToken` option) is set.
 * Binding to a non-loopback host without a token is rejected at startup.
 */

import type { NextFunction, Request, Response } from 'express';
import type { IncomingMessage } from 'node:http';

export function isLoopbackHost(host: string): boolean {
  return (
    host === '127.0.0.1' ||
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]'
  );
}

export function resolveHubAuthToken(explicit?: string): string | undefined {
  const fromEnv = process.env.SHEPAW_HUB_TOKEN?.trim();
  const token = (explicit ?? fromEnv ?? '').trim();
  return token.length > 0 ? token : undefined;
}

export function extractBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

export function extractTokenFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url, 'http://localhost');
    return parsed.searchParams.get('token')?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Constant-time string compare for tokens. */
export function tokensEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still walk both to reduce length-based timing signal somewhat.
    let diff = a.length ^ b.length;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i % b.length);
    }
    return diff === 0 && a.length === b.length;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function createAuthMiddleware(token: string | undefined) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!token) {
      next();
      return;
    }

    // Health remains public so reverse proxies / probes can check liveness.
    if (req.path === '/health' || req.path === '/api/health') {
      next();
      return;
    }

    const provided =
      extractBearerToken(req.header('authorization')) ??
      (typeof req.query.token === 'string' ? req.query.token.trim() : undefined);

    if (!provided || !tokensEqual(provided, token)) {
      res.status(401).json({ error: 'Unauthorized. Set Authorization: Bearer <SHEPAW_HUB_TOKEN>.' });
      return;
    }
    next();
  };
}

export function authorizeWsUpgrade(
  req: IncomingMessage,
  token: string | undefined,
): boolean {
  if (!token) return true;
  const provided =
    extractBearerToken(req.headers.authorization) ??
    extractTokenFromUrl(req.url);
  return Boolean(provided && tokensEqual(provided, token));
}
