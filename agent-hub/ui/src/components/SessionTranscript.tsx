import { useCallback, useEffect, useRef } from 'react';
import type { SessionHistoryMessage } from '../api/types.js';
import { useI18n, type MessageKey } from '../i18n/index.js';
import { ChatMarkdown, TypewriterChatMarkdown } from './ChatMarkdown.js';
import { chat } from '../utils/chatTheme.js';

interface SessionTranscriptProps {
  sessionId: string | null;
  messages: SessionHistoryMessage[];
  loading: boolean;
  error: string | null;
  pendingReply?: boolean;
  streamingMessageKey?: string | null;
  onStreamingComplete?: () => void;
  workspaceUri?: string;
  onOpenStore?: (uri: string) => void;
}

export function SessionTranscript({
  sessionId,
  messages,
  loading,
  error,
  pendingReply = false,
  streamingMessageKey = null,
  onStreamingComplete,
  workspaceUri,
  onOpenStore,
}: SessionTranscriptProps) {
  const { t } = useI18n();
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages.length, pendingReply, streamingMessageKey, scrollToBottom]);

  if (sessionId === null) {
    return (
      <div style={placeholder}>
        <div style={welcomeIcon}>✨</div>
        <h4 style={welcomeTitle}>{t('sessions.welcomeTitle')}</h4>
        <p style={hint}>{t('sessions.selectPrompt')}</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={placeholder}>
        <div style={loadingDots}>
          <span style={dot} />
          <span style={{ ...dot, animationDelay: '0.15s' }} />
          <span style={{ ...dot, animationDelay: '0.3s' }} />
        </div>
        <p style={hint}>{t('sessions.loadingHistory')}</p>
      </div>
    );
  }

  if (error && messages.length === 0 && !pendingReply) {
    return (
      <div style={placeholder}>
        <p style={errorText}>{error}</p>
      </div>
    );
  }

  if (messages.length === 0 && !pendingReply) {
    return (
      <div style={placeholder}>
        <div style={welcomeIcon}>👋</div>
        <h4 style={welcomeTitle}>{t('sessions.welcomeTitle')}</h4>
        <p style={hint}>{t('sessions.noHistory')}</p>
      </div>
    );
  }

  return (
    <>
      <style>{`
        @keyframes chatDotPulse {
          0%, 80%, 100% { opacity: 0.35; transform: scale(0.85); }
          40% { opacity: 1; transform: scale(1); }
        }
        @keyframes chatTypeCursor {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
      `}</style>
      <div style={transcript}>
        {messages.map((message, index) => {
          const isUser = message.role === 'user';
          const messageKey = message.message_id ?? `${message.role}-${index}`;
          const isStreaming = !isUser && streamingMessageKey === messageKey;

          return (
            <div
              key={messageKey}
              style={{
                ...messageRow,
                flexDirection: isUser ? 'row-reverse' : 'row',
              }}
            >
              <div
                style={{
                  ...avatar,
                  background: isUser ? chat.colors.userAvatar : chat.colors.agentAvatar,
                  color: isUser ? chat.colors.textPrimary : chat.colors.accent,
                }}
                aria-hidden
              >
                {isUser ? 'U' : 'A'}
              </div>
              <div
                style={{
                  ...bubbleWrap,
                  alignItems: isUser ? 'flex-end' : 'flex-start',
                }}
              >
                <span style={roleLabel}>{isUser ? t('sessions.you') : t('sessions.agent')}</span>
                <div
                  style={{
                    ...bubble,
                    background: isUser ? chat.colors.userBubble : chat.colors.agentBubble,
                    borderBottomRightRadius: isUser ? 4 : chat.radius.lg,
                    borderBottomLeftRadius: isUser ? chat.radius.lg : 4,
                  }}
                >
                  {!isUser && message.progress_content !== undefined && message.progress_content.length > 0 && (
                    <details
                      style={progressBlock}
                      open={message.progress_auto_collapse === false || isStreaming}
                    >
                      <summary style={progressSummary}>
                        {progressLabel(message.progress_title, t)}
                      </summary>
                      <div style={progressBody}>
                        <ChatMarkdown
                          content={message.progress_content}
                          workspaceUri={workspaceUri}
                          onOpenStore={onOpenStore}
                          compact
                        />
                      </div>
                    </details>
                  )}
                  {message.content.length > 0 && (
                    <div style={content}>
                      {isUser ? (
                        <ChatMarkdown
                          content={message.content}
                          workspaceUri={workspaceUri}
                          onOpenStore={onOpenStore}
                        />
                      ) : isStreaming ? (
                        <TypewriterChatMarkdown
                          content={message.content}
                          animate
                          workspaceUri={workspaceUri}
                          onOpenStore={onOpenStore}
                          onProgress={scrollToBottom}
                          onAnimationComplete={onStreamingComplete}
                        />
                      ) : (
                        <ChatMarkdown
                          content={message.content}
                          workspaceUri={workspaceUri}
                          onOpenStore={onOpenStore}
                        />
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {pendingReply && (
          <div style={{ ...messageRow, flexDirection: 'row' }}>
            <div
              style={{
                ...avatar,
                background: chat.colors.agentAvatar,
                color: chat.colors.accent,
              }}
              aria-hidden
            >
              A
            </div>
            <div style={{ ...bubbleWrap, alignItems: 'flex-start' }}>
              <span style={roleLabel}>{t('sessions.agent')}</span>
              <div
                style={{
                  ...bubble,
                  background: chat.colors.agentBubble,
                  borderBottomLeftRadius: 4,
                }}
              >
                <div style={typingRow}>
                  <div style={loadingDots}>
                    <span style={dot} />
                    <span style={{ ...dot, animationDelay: '0.15s' }} />
                    <span style={{ ...dot, animationDelay: '0.3s' }} />
                  </div>
                  <span style={typingText}>{t('sessions.thinking')}</span>
                </div>
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </>
  );
}

function progressLabel(
  title: string | undefined,
  t: (key: MessageKey) => string,
): string {
  if (title === undefined || title.length === 0 || title === 'Thinking') {
    return t('sessions.progressThinking');
  }
  if (title === 'Plan') return t('sessions.progressPlan');
  return title;
}

const transcript: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  minHeight: 0,
  padding: '20px 20px 12px',
  display: 'flex',
  flexDirection: 'column',
  gap: 20,
};

const placeholder: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 32,
  minHeight: 0,
  gap: 8,
};

const welcomeIcon: React.CSSProperties = {
  fontSize: 36,
  marginBottom: 4,
  opacity: 0.7,
};

const welcomeTitle: React.CSSProperties = {
  margin: 0,
  fontSize: 18,
  fontWeight: 600,
  color: chat.colors.textPrimary,
  letterSpacing: '-0.02em',
};

const hint: React.CSSProperties = {
  color: chat.colors.textMuted,
  fontSize: 13,
  margin: 0,
  textAlign: 'center',
  maxWidth: 360,
  lineHeight: 1.55,
};

const errorText: React.CSSProperties = {
  color: chat.colors.error,
  fontSize: 13,
  margin: 0,
  textAlign: 'center',
  maxWidth: 360,
  lineHeight: 1.55,
};

const messageRow: React.CSSProperties = {
  display: 'flex',
  gap: 12,
  width: '100%',
  alignItems: 'flex-start',
};

const avatar: React.CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: chat.radius.full,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 12,
  fontWeight: 700,
  flexShrink: 0,
  letterSpacing: '0.02em',
};

const bubbleWrap: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  maxWidth: 'min(78%, 640px)',
  minWidth: 0,
};

const roleLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: chat.colors.textMuted,
  padding: '0 4px',
  letterSpacing: '0.02em',
};

const bubble: React.CSSProperties = {
  padding: '10px 14px',
  borderRadius: chat.radius.lg,
  boxShadow: chat.shadow.sm,
};

const content: React.CSSProperties = {
  margin: 0,
  minWidth: 0,
};

const progressBlock: React.CSSProperties = {
  margin: '0 0 8px',
  padding: '8px 10px',
  background: chat.colors.bgElevated,
  borderRadius: chat.radius.sm,
  border: `1px solid ${chat.colors.border}`,
};

const progressSummary: React.CSSProperties = {
  cursor: 'pointer',
  fontSize: 11,
  fontWeight: 600,
  color: chat.colors.textSecondary,
  letterSpacing: '0.03em',
};

const progressBody: React.CSSProperties = {
  margin: '8px 0 0',
};

const loadingDots: React.CSSProperties = {
  display: 'flex',
  gap: 5,
  alignItems: 'center',
};

const dot: React.CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: chat.radius.full,
  background: chat.colors.accent,
  animation: 'chatDotPulse 1.2s ease-in-out infinite',
};

const typingRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};

const typingText: React.CSSProperties = {
  fontSize: 13,
  color: chat.colors.textMuted,
};
