import type { LiveSession } from '../api/types.js';
import { useI18n } from '../i18n/index.js';
import type { MessageKey } from '../i18n/en.js';
import { chat } from '../utils/chatTheme.js';

interface SessionListProps {
  sessions: LiveSession[];
  selectedSessionId: string | null;
  loading: boolean;
  error: string | null;
  onSelect: (sessionId: string) => void;
}

function formatRelativeTime(
  iso: string | undefined,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string {
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

export function sessionDisplayTitle(session: LiveSession): string {
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
    return (
      <div style={stateWrap}>
        <p style={hint}>{t('sessions.loading')}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div style={stateWrap}>
        <p style={errorText}>{error}</p>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div style={stateWrap}>
        <div style={emptyIcon}>💬</div>
        <p style={hint}>{t('sessions.none')}</p>
      </div>
    );
  }

  return (
    <div style={list}>
      {sessions.map((session) => {
        const selected = session.session_id === selectedSessionId;
        const title = sessionDisplayTitle(session);
        return (
          <button
            key={session.session_id}
            type="button"
            style={{
              ...item,
              background: selected ? chat.colors.bgSelected : 'transparent',
              borderColor: selected ? chat.colors.accent : 'transparent',
            }}
            onClick={() => onSelect(session.session_id)}
          >
            <div style={itemRow}>
              <span style={itemAvatar}>💬</span>
              <div style={itemBody}>
                <span
                  style={{
                    ...titleStyle,
                    color: selected ? chat.colors.textPrimary : chat.colors.textSecondary,
                  }}
                >
                  {title}
                </span>
                <span style={meta}>{formatRelativeTime(session.updated_at, t)}</span>
              </div>
            </div>
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
  padding: '0 8px',
};

const item: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '10px 10px',
  border: '1px solid transparent',
  borderRadius: chat.radius.md,
  cursor: 'pointer',
  color: chat.colors.textPrimary,
  fontFamily: 'inherit',
  transition: 'background 0.15s ease',
};

const itemRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
};

const itemAvatar: React.CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: chat.radius.sm,
  background: chat.colors.bgHover,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 14,
  flexShrink: 0,
};

const itemBody: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

const titleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  wordBreak: 'break-word',
  overflow: 'hidden',
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
};

const meta: React.CSSProperties = {
  fontSize: 11,
  color: chat.colors.textMuted,
};

const stateWrap: React.CSSProperties = {
  padding: '20px 16px',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 8,
  textAlign: 'center',
};

const emptyIcon: React.CSSProperties = {
  fontSize: 24,
  opacity: 0.45,
};

const hint: React.CSSProperties = {
  color: chat.colors.textMuted,
  fontSize: 12,
  margin: 0,
  lineHeight: 1.5,
};

const errorText: React.CSSProperties = {
  color: chat.colors.error,
  fontSize: 12,
  margin: 0,
  lineHeight: 1.5,
};
