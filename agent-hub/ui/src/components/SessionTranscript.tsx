import type { SessionHistoryMessage } from '../api/types.js';

interface SessionTranscriptProps {
  sessionId: string | null;
  messages: SessionHistoryMessage[];
  loading: boolean;
  error: string | null;
}

export function SessionTranscript({
  sessionId,
  messages,
  loading,
  error,
}: SessionTranscriptProps) {
  if (sessionId === null) {
    return (
      <div style={placeholder}>
        <p style={hint}>Select a session to view its conversation.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={placeholder}>
        <p style={hint}>Loading history… This may take up to 40 seconds.</p>
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
          No history for this session. Some engines do not support transcript replay.
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
              <span style={roleLabel}>{isUser ? 'You' : 'Agent'}</span>
              <p style={content}>{message.content}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
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
