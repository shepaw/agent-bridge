/**
 * Heuristic: env var names that look like secrets should be masked in the
 * dashboard and use password inputs. Non-secrets (URLs, model IDs, flags)
 * stay readable as plain text.
 *
 * Matches KEY / TOKEN / SECRET / PASSWORD / CREDENTIAL as whole segments
 * (e.g. ANTHROPIC_API_KEY, AUTH_TOKEN) — not substrings like "KEYBOARD".
 */
const SENSITIVE_ENV_SEGMENT =
  /(?:^|_)(?:API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PASS)(?:_|$)/i;

export function isSensitiveEnvVarKey(key: string): boolean {
  const trimmed = key.trim();
  if (trimmed.length === 0) return true; // unknown draft key → treat as secret
  return SENSITIVE_ENV_SEGMENT.test(trimmed);
}
