import type { LiveSession } from '../api/types.js';
import { useI18n } from '../i18n/index.js';
import type { MessageKey } from '../i18n/en.js';

interface SessionListProps {
  sessions: LiveSession[];
  selectedSessionId: string | null;
  loading: boolean;
  error: string | null;
  onSelect: (sessionId: string) => void;
}

function formatRelativeTime(iso: string | undefined, t: (key: MessageKey, vars?: Record<string, string | number>) => string): string {
  if (iso === undefined || iso.length === 0) return '—';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;

  const diffSec = Math.round((Date.now() - ts) / 1000);
  if (diffSec < 60) return t('sessions.justNow');
  if (diffSec < 3600) return t('sessions.minutesAgo', { n: Math.floor(diffSec / 60) });
  if (diffSec < 86_400) return t('sessions.hoursAgo', { n: Math.floor(diffSec / 3600) });
  if (diffSec < 604_800) return t('sessions.daysAgo', { n: Math.floor(diffSec / 86_400) });
  return new Date(ts).toLocaleDateString();
}

function sessionLabel(session: LiveSession): string {
  if (session.title !== undefined && session.title.length > 0) return session.title;
  if (session.session_id.length <= 20) return session.session_id;
  return `${session.session_id.slice(0, 8)}…${session.session_id.slice(-6)}`;
}

export function SessionList({
  sessions,
  selectedSessionId,
  loading,
  error,
  onSelect,
}: SessionListProps) {
  const { t } = useI18n();

  if (loading && sessions.length === 0) {
    return <p style={hint}>{t('sessions.loading')}</p>;
  }

  if (error) {
    return (
      <div>
        <p style={errorText}>{error}</p>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <p style={hint}>
        {t('sessions.none')}
      </p>
    );
  }

  return (
    <div style={list}>
      {sessions.map((session) => {
        const selected = session.session_id === selectedSessionId;
        return (
          <button
            key={session.session_id}
            type="button"
            style={{
              ...item,
              background: selected ? '#313244' : 'transparent',
              borderLeft: selected ? '3px solid #89b4fa' : '3px solid transparent',
            }}
            onClick={() => onSelect(session.session_id)}
          >
            <span style={title}>{sessionLabel(session)}</span>
            <span style={meta}>{formatRelativeTime(session.updated_at, t)}</span>
            <code style={idCode}>{session.session_id}</code>
          </button>
        );
      })}
    </div>
  );
}

const list: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  overflowY: 'auto',
  flex: 1,
  minHeight: 0,
};

const item: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 2,
  width: '100%',
  textAlign: 'left',
  padding: '10px 12px',
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  color: '#cdd6f4',
};

const title: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: '#cdd6f4',
  wordBreak: 'break-word',
};

const meta: React.CSSProperties = {
  fontSize: 11,
  color: '#a6adc8',
};

const idCode: React.CSSProperties = {
  fontSize: 10,
  color: '#6c7086',
  wordBreak: 'break-all',
};

const hint: React.CSSProperties = {
  color: '#a6adc8',
  fontSize: 13,
  margin: 0,
  padding: '12px 8px',
};

const errorText: React.CSSProperties = {
  color: '#f38ba8',
  fontSize: 13,
  margin: '8px 0',
};
