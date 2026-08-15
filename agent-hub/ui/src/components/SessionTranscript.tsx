import type { ReactNode } from 'react';
import type { SessionHistoryMessage } from '../api/types.js';
import { useI18n } from '../i18n/index.js';
import { resolveWorkspaceFileUri } from '../utils/workspaceHref.js';

interface SessionTranscriptProps {
  sessionId: string | null;
  messages: SessionHistoryMessage[];
  loading: boolean;
  error: string | null;
  workspaceUri?: string;
  onOpenStore?: (uri: string) => void;
}

export function SessionTranscript({
  sessionId,
  messages,
  loading,
  error,
  workspaceUri,
  onOpenStore,
}: SessionTranscriptProps) {
  const { t } = useI18n();

  if (sessionId === null) {
    return (
      <div style={placeholder}>
        <p style={hint}>{t('sessions.selectPrompt')}</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={placeholder}>
        <p style={hint}>{t('sessions.loadingHistory')}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div style={placeholder}>
        <p style={errorText}>{error}</p>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div style={placeholder}>
        <p style={hint}>
          {t('sessions.noHistory')}
        </p>
      </div>
    );
  }

  return (
    <div style={transcript}>
      {messages.map((message, index) => {
        const isUser = message.role === 'user';
        return (
          <div
            key={message.message_id ?? `${message.role}-${index}`}
            style={{
              ...bubbleRow,
              justifyContent: isUser ? 'flex-end' : 'flex-start',
            }}
          >
            <div
              style={{
                ...bubble,
                background: isUser ? '#1e3a5f' : '#313244',
                borderTopRightRadius: isUser ? 4 : 12,
                borderTopLeftRadius: isUser ? 12 : 4,
              }}
            >
              <span style={roleLabel}>{isUser ? t('sessions.you') : t('sessions.agent')}</span>
              <p style={content}>
                {renderMessageContent(message.content, workspaceUri, onOpenStore)}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function renderMessageContent(
  text: string,
  workspaceUri: string | undefined,
  onOpenStore?: (uri: string) => void,
): ReactNode {
  const nodes: ReactNode[] = [];
  const re = /\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      nodes.push(text.slice(last, match.index));
    }
    const label = match[1] ?? '';
    const href = match[2] ?? '';
    const storeUri = resolveWorkspaceFileUri(workspaceUri, href);
    if (storeUri && onOpenStore) {
      nodes.push(
        <button
          key={`l-${key++}`}
          type="button"
          style={linkBtn}
          onClick={() => onOpenStore(storeUri)}
          title={storeUri}
        >
          {label || href}
        </button>,
      );
    } else if (/^https?:\/\//i.test(href)) {
      nodes.push(
        <a key={`a-${key++}`} href={href} target="_blank" rel="noreferrer" style={webLink}>
          {label || href}
        </a>,
      );
    } else {
      nodes.push(match[0]);
    }
    last = match.index + match[0].length;
  }
  if (nodes.length === 0) return text;
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const transcript: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  minHeight: 0,
  padding: '12px 14px',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const placeholder: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
  minHeight: 0,
};

const hint: React.CSSProperties = {
  color: '#a6adc8',
  fontSize: 13,
  margin: 0,
  textAlign: 'center',
};

const errorText: React.CSSProperties = {
  color: '#f38ba8',
  fontSize: 13,
  margin: 0,
  textAlign: 'center',
};

const bubbleRow: React.CSSProperties = {
  display: 'flex',
  width: '100%',
};

const bubble: React.CSSProperties = {
  maxWidth: '85%',
  padding: '10px 12px',
  borderRadius: 12,
};

const roleLabel: React.CSSProperties = {
  display: 'block',
  fontSize: 10,
  fontWeight: 600,
  color: '#a6adc8',
  marginBottom: 4,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};

const content: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: 1.55,
  color: '#cdd6f4',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const linkBtn: React.CSSProperties = {
  display: 'inline',
  padding: 0,
  margin: 0,
  border: 'none',
  background: 'none',
  color: '#89b4fa',
  cursor: 'pointer',
  font: 'inherit',
  textDecoration: 'underline',
};

const webLink: React.CSSProperties = {
  color: '#89b4fa',
};
