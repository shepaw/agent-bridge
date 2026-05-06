/**
 * Mask a secret value for display, showing only the first few and last few characters.
 *
 * Examples:
 *   "sk-ant-abc123def456789" → "sk-ant-ab***789"
 *   "short"                  → "sh***rt"
 *   "ab"                     → "**"
 *   ""                       → ""
 */
export function maskSecret(secret: string): string {
  if (!secret) return '';
  const len = secret.length;
  if (len <= 4) return '*'.repeat(len);
  // Show up to 4 chars at start, up to 4 at end, mask the middle
  const headLen = Math.min(4, Math.floor(len / 3));
  const tailLen = Math.min(4, Math.floor(len / 4));
  const head = secret.slice(0, headLen);
  const tail = secret.slice(len - tailLen);
  return `${head}***${tail}`;
}
