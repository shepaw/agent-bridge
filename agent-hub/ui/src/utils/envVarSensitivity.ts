/**
 * Heuristic: secret-like env names use password inputs + masked display;
 * URLs / model IDs / flags stay plain text. Keep in sync with
 * `@shepaw/agent-hub-core` `isSensitiveEnvVarKey`.
 */
const SENSITIVE_ENV_SEGMENT =
  /(?:^|_)(?:API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PASS)(?:_|$)/i;

export function isSensitiveEnvVarKey(key: string): boolean {
  const trimmed = key.trim();
  if (trimmed.length === 0) return true;
  return SENSITIVE_ENV_SEGMENT.test(trimmed);
}
