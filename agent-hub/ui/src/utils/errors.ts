/** True when an API error message indicates a missing/invalid dashboard token. */
export function isUnauthorizedError(error: string | null): boolean {
  if (!error) return false;
  return /unauthorized|SHEPAW_HUB_TOKEN/i.test(error);
}
