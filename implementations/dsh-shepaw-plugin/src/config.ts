/**
 * Configuration for the Shepaw↔DSH bridge plugin.
 *
 * Values come from the `config:` block of the plugin entry in the profile's
 * `cordis.patch.yml`. Everything is optional and defaulted here.
 */

export interface ShepawBridgeConfig {
  /** Shepaw WS bind host. Default `0.0.0.0` (LAN-reachable for the app). */
  host?: string;
  /** Shepaw WS listen port. Default `8080`. */
  port?: number;
  /** Agent display name surfaced to the Shepaw app. Default `DeepSeek Harness`. */
  name?: string;
  /** Default working directory for new DSH sessions (must be absolute). */
  cwd?: string;
  /** Override the Shepaw identity file path (X25519 keypair + agentId). */
  identityPath?: string;
  /** Override the authorized-peers allowlist path. */
  peersPath?: string;
  /** Override the enrollment-tokens store path. */
  enrollmentsPath?: string;
  /** Max concurrent Shepaw chat tasks. Default `5`. */
  maxConcurrency?: number;
  /** Provider route override; defaults to the profile's `agentDefaultModel`. */
  provider?: string;
  /** Model id override; defaults to the profile's `agentDefaultModel`. */
  model?: string;
}

export interface ResolvedShepawBridgeConfig {
  host: string;
  port: number;
  name: string;
  cwd: string;
  identityPath?: string;
  peersPath?: string;
  enrollmentsPath?: string;
  maxConcurrency: number;
  provider?: string;
  model?: string;
}

/** Parse a positive-integer env port, or undefined when absent/invalid. */
function envPort(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : undefined;
}

export function resolveShepawBridgeConfig(
  raw: Partial<ShepawBridgeConfig> | undefined,
): ResolvedShepawBridgeConfig {
  const c = raw ?? {};
  // Hub injects `SHEPAW_DSH_HOST` / `SHEPAW_DSH_PORT` per instance (loopback +
  // unique port). Env wins over cordis.patch.yml defaults (which still ship
  // 0.0.0.0:8080 for standalone `dsh --profile shepaw` runs).
  const envHost = process.env.SHEPAW_DSH_HOST?.trim();
  const host = envHost && envHost.length > 0 ? envHost : (c.host ?? '0.0.0.0');
  const port = envPort(process.env.SHEPAW_DSH_PORT) ?? c.port ?? 8080;
  return {
    host,
    port,
    name: c.name ?? 'DeepSeek Harness',
    cwd: c.cwd ?? process.cwd(),
    maxConcurrency: c.maxConcurrency ?? 5,
    ...(c.identityPath !== undefined ? { identityPath: c.identityPath } : {}),
    ...(c.peersPath !== undefined ? { peersPath: c.peersPath } : {}),
    ...(c.enrollmentsPath !== undefined ? { enrollmentsPath: c.enrollmentsPath } : {}),
    ...(c.provider !== undefined ? { provider: c.provider } : {}),
    ...(c.model !== undefined ? { model: c.model } : {}),
  };
}
