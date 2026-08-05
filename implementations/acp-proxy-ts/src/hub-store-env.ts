/**
 * Env helper: point StoreToolsClient at the hub peer store HTTP API.
 *
 * When peer service is running (default :18792), agents can use the same
 * store_* HTTP surface without a separate Nexuspouch process:
 *   SHEPAW_HUB_STORE_URL=http://127.0.0.1:18792
 *   SHEPAW_HUB_STORE_DEVICE=<hub-fingerprint>   # optional; /api/v1/health
 */

export function resolveHubStoreBase(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const explicit = (env.SHEPAW_HUB_STORE_URL ?? '').trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const flag = (env.SHEPAW_PEER_STORE ?? '').trim().toLowerCase();
  if (flag === '1' || flag === 'true' || flag === 'on') {
    const host = (env.SHEPAW_PEER_HOST ?? '127.0.0.1').trim() || '127.0.0.1';
    const port = (env.SHEPAW_PEER_PORT ?? '18792').trim() || '18792';
    return `http://${host}:${port}`;
  }
  return undefined;
}
