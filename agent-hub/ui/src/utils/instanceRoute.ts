/** Parse `#instance/<id>` and optional `/sessions/<sessionId>` from the location hash. */

export interface InstanceRoute {
  instanceId: string;
  sessionId: string | null;
}

export function parseInstanceHash(hash: string): InstanceRoute | null {
  const withSession = hash.match(/^#instance\/([^/]+)\/sessions\/([^/]+)$/);
  if (withSession) {
    return {
      instanceId: decodeURIComponent(withSession[1]!),
      sessionId: decodeURIComponent(withSession[2]!),
    };
  }

  const basic = hash.match(/^#instance\/([^/]+)$/);
  if (basic) {
    return { instanceId: decodeURIComponent(basic[1]!), sessionId: null };
  }

  return null;
}

export function buildInstanceHash(instanceId: string, sessionId?: string | null): string {
  const base = `instance/${encodeURIComponent(instanceId)}`;
  if (sessionId !== undefined && sessionId !== null && sessionId.length > 0) {
    return `${base}/sessions/${encodeURIComponent(sessionId)}`;
  }
  return base;
}
