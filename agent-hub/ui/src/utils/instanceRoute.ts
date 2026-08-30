/** Parse `#instance/<id>` with optional tab or `/sessions/<sessionId>` from the location hash. */

export type InstanceDetailTab =
  | 'overview'
  | 'sessions'
  | 'logs'
  | 'devices'
  | 'attachments'
  | 'resume'
  | 'config';

const INSTANCE_TABS: InstanceDetailTab[] = [
  'overview',
  'sessions',
  'logs',
  'devices',
  'attachments',
  'resume',
  'config',
];

export interface InstanceRoute {
  instanceId: string;
  sessionId: string | null;
  tab: InstanceDetailTab;
}

function parseTab(raw: string | undefined): InstanceDetailTab {
  if (raw && (INSTANCE_TABS as string[]).includes(raw)) {
    return raw as InstanceDetailTab;
  }
  return 'overview';
}

export function parseInstanceHash(hash: string): InstanceRoute | null {
  const withSession = hash.match(/^#instance\/([^/]+)\/sessions\/([^/]+)$/);
  if (withSession) {
    return {
      instanceId: decodeURIComponent(withSession[1]!),
      sessionId: decodeURIComponent(withSession[2]!),
      tab: 'sessions',
    };
  }

  const withTab = hash.match(
    /^#instance\/([^/]+)\/(overview|sessions|logs|devices|attachments|resume|config)$/,
  );
  if (withTab) {
    return {
      instanceId: decodeURIComponent(withTab[1]!),
      sessionId: null,
      tab: parseTab(withTab[2]),
    };
  }

  const basic = hash.match(/^#instance\/([^/]+)$/);
  if (basic) {
    return { instanceId: decodeURIComponent(basic[1]!), sessionId: null, tab: 'overview' };
  }

  return null;
}

export function buildInstanceHash(
  instanceId: string,
  options?: { sessionId?: string | null; tab?: InstanceDetailTab },
): string {
  const sessionId = options?.sessionId;
  if (sessionId !== undefined && sessionId !== null && sessionId.length > 0) {
    return `instance/${encodeURIComponent(instanceId)}/sessions/${encodeURIComponent(sessionId)}`;
  }

  const tab = options?.tab ?? 'overview';
  const base = `instance/${encodeURIComponent(instanceId)}`;
  if (tab === 'overview') return base;
  return `${base}/${tab}`;
}
