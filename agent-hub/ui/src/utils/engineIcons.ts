import { getHubAuthToken } from '../api/client.js';

/** URL for GET /api/engines/:id/icon (includes auth token query param when set). */
export function getEngineIconUrl(engineId: string): string {
  const params = new URLSearchParams();
  const token = getHubAuthToken();
  if (token) params.set('token', token);
  const qs = params.toString();
  return `/api/engines/${encodeURIComponent(engineId)}/icon${qs ? `?${qs}` : ''}`;
}
