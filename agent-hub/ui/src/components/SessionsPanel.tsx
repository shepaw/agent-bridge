import { useMemo, useState } from 'react';
import { useConversations } from '../hooks/useConversations.js';
import type { InstanceStatus } from '../api/types.js';
import { SessionList, sessionDisplayTitle } from './SessionList.js';
import { SessionTranscript } from './SessionTranscript.js';
import { ChatComposer } from './ChatComposer.js';
import { CliSessionSyncModal } from './CliSessionSyncModal.js';
import type { CliSessionSyncSource } from '../api/types.js';
import { useI18n } from '../i18n/index.js';
import { chat } from '../utils/chatTheme.js';

interface SessionsPanelProps {
  instanceId: string;
  engine: string;
  status: InstanceStatus;
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string | null) => void;
  onManageMappings?: () => void;
  workspaceUri?: string;
  onOpenStore?: (uri: string) => void;
}

export function SessionsPanel({
  instanceId,
  engine,
  status,
  selectedSessionId,
  onSelectSession,
  onManageMappings,
  workspaceUri,
  onOpenStore,
}: SessionsPanelProps) {
  const { t } = useI18n();
  const [showCliSync, setShowCliSync] = useState(false);
  const CLI_SYNC_BY_ENGINE: Partial<Record<string, CliSessionSyncSource>> = {
    cursor: 'cursor',
    'claude-code': 'claude-code',
    codex: 'codex',
    opencode: 'opencode',
    openclaw: 'openclaw',
  };
  const cliSyncSource = CLI_SYNC_BY_ENGINE[engine] ?? null;
  const {
    sessions,
    listLoading,
    listRefreshing,
    listError,
    messages,
    historyLoading,
    historyError,
    gatewayReady,
    sending,
    sendError,
    pendingReply,
    streamingMessageKey,
    clearStreamingMessage,
    loadSessions,
    startNewSession,
    sendChat,
  } = useConversations({
    instanceId,
    status,
    selectedSessionId,
    onSelectSession,
  });

  const offlineMessage =
    status.availability === 'starting'
      ? t('sessions.starting')
      : t('sessions.startFirst');

  const sessionCountLabel = sessions.length === 1
    ? t('sessions.count', { count: sessions.length })
    : t('sessions.countPlural', { count: sessions.length });

  const selectedSession = useMemo(
    () => sessions.find((s) => s.session_id === selectedSessionId) ?? null,
    [sessions, selectedSessionId],
  );

  const chatTitle = selectedSession
    ? sessionDisplayTitle(selectedSession)
    : t('sessions.newChat');

  return (
    <div style={wrapper}>
      {!gatewayReady ? (
        <div style={offlineBox}>
          <div style={offlineIcon}>💬</div>
          <p style={offlineText}>{offlineMessage}</p>
        </div>
      ) : (
        <div style={layout}>
          <aside style={sidebar}>
            <div style={sidebarHeader}>
              <div>
                <h4 style={sidebarTitle}>{t('sessions.chatsTitle')}</h4>
                <span style={sidebarMeta}>{sessionCountLabel}</span>
              </div>
              <button
                type="button"
                style={newChatBtn}
                disabled={sending}
                title={t('sessions.newChat')}
                onClick={() => startNewSession()}
              >
                +
              </button>
            </div>

            <div style={sidebarList}>
              <SessionList
                sessions={sessions}
                selectedSessionId={selectedSessionId}
                loading={listLoading}
                error={listError}
                onSelect={onSelectSession}
              />
            </div>

            <div style={sidebarFooter}>
              {cliSyncSource !== null && (
                <button
                  type="button"
                  style={footerBtn}
                  onClick={() => setShowCliSync(true)}
                >
                  {t(
                    cliSyncSource === 'cursor'
                      ? 'cursorIde.openBtn'
                      : cliSyncSource === 'claude-code'
                        ? 'claudeCode.openBtn'
                        : cliSyncSource === 'codex'
                          ? 'codex.openBtn'
                          : cliSyncSource === 'opencode'
                            ? 'opencode.openBtn'
                            : 'openclaw.openBtn',
                  )}
                </button>
              )}
              {onManageMappings !== undefined && (
                <button type="button" style={footerBtn} onClick={onManageMappings}>
                  {t('sessions.manage')}
                </button>
              )}
              <button
                type="button"
                style={{
                  ...footerBtn,
                  opacity: listRefreshing ? 0.65 : 1,
                }}
                disabled={listLoading}
                onClick={() => void loadSessions('manual')}
              >
                {t('common.refresh')}
              </button>
            </div>
          </aside>

          <main style={main}>
            <header style={chatHeader}>
              <div style={chatHeaderInfo}>
                <div style={chatHeaderAvatar}>
                  {selectedSession ? '💬' : '✨'}
                </div>
                <div style={{ minWidth: 0 }}>
                  <h4 style={chatHeaderTitle}>{chatTitle}</h4>
                  {selectedSession && (
                    <code style={chatHeaderId}>{selectedSession.session_id}</code>
                  )}
                </div>
              </div>
              {selectedSessionId !== null && (
                <button
                  type="button"
                  style={headerActionBtn}
                  disabled={sending}
                  onClick={() => startNewSession()}
                >
                  {t('sessions.newChat')}
                </button>
              )}
            </header>

            <SessionTranscript
              sessionId={selectedSessionId}
              messages={messages}
              loading={historyLoading}
              error={historyError}
              pendingReply={pendingReply}
              streamingMessageKey={streamingMessageKey}
              onStreamingComplete={clearStreamingMessage}
              workspaceUri={workspaceUri}
              onOpenStore={onOpenStore}
            />

            <ChatComposer
              disabled={!gatewayReady || historyLoading}
              sending={sending}
              error={sendError}
              onSend={(message) => void sendChat(message)}
            />
          </main>
        </div>
      )}

      {showCliSync && cliSyncSource !== null && (
        <CliSessionSyncModal
          instanceId={instanceId}
          source={cliSyncSource}
          onClose={() => setShowCliSync(false)}
          onSynced={() => void loadSessions('manual')}
        />
      )}
    </div>
  );
}

const wrapper: React.CSSProperties = {
  background: chat.colors.bgBase,
  border: `1px solid ${chat.colors.border}`,
  borderRadius: chat.radius.lg,
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  minHeight: 620,
  height: 'clamp(620px, calc(100vh - 240px), 860px)',
  boxShadow: chat.shadow.md,
  fontFamily: chat.font,
};

const layout: React.CSSProperties = {
  display: 'flex',
  flex: 1,
  minHeight: 0,
};

const sidebar: React.CSSProperties = {
  width: chat.sidebarWidth,
  flexShrink: 0,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  background: chat.colors.bgElevated,
  borderRight: `1px solid ${chat.colors.borderSubtle}`,
};

const sidebarHeader: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 8,
  padding: '14px 14px 10px',
  borderBottom: `1px solid ${chat.colors.borderSubtle}`,
};

const sidebarTitle: React.CSSProperties = {
  margin: 0,
  fontSize: 14,
  fontWeight: 700,
  color: chat.colors.textPrimary,
  letterSpacing: '-0.01em',
};

const sidebarMeta: React.CSSProperties = {
  display: 'block',
  marginTop: 2,
  fontSize: 11,
  color: chat.colors.textMuted,
};

const newChatBtn: React.CSSProperties = {
  width: 32,
  height: 32,
  flexShrink: 0,
  border: 'none',
  borderRadius: chat.radius.full,
  background: chat.colors.accent,
  color: chat.colors.accentFg,
  fontSize: 20,
  fontWeight: 500,
  lineHeight: 1,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  boxShadow: chat.shadow.sm,
};

const sidebarList: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  padding: '6px 0',
};

const sidebarFooter: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  padding: '10px 12px',
  borderTop: `1px solid ${chat.colors.borderSubtle}`,
  background: chat.colors.bgSurface,
};

const footerBtn: React.CSSProperties = {
  background: 'transparent',
  border: `1px solid ${chat.colors.border}`,
  color: chat.colors.textSecondary,
  borderRadius: chat.radius.sm,
  padding: '4px 10px',
  cursor: 'pointer',
  fontSize: 11,
  fontFamily: 'inherit',
};

const main: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
  minHeight: 0,
  background: chat.colors.bgSurface,
};

const chatHeader: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '12px 16px',
  borderBottom: `1px solid ${chat.colors.borderSubtle}`,
  background: chat.colors.bgElevated,
  flexShrink: 0,
};

const chatHeaderInfo: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  minWidth: 0,
};

const chatHeaderAvatar: React.CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: chat.radius.md,
  background: chat.colors.bgHover,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 16,
  flexShrink: 0,
};

const chatHeaderTitle: React.CSSProperties = {
  margin: 0,
  fontSize: 14,
  fontWeight: 600,
  color: chat.colors.textPrimary,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const chatHeaderId: React.CSSProperties = {
  display: 'block',
  marginTop: 2,
  fontSize: 10,
  color: chat.colors.textMuted,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  maxWidth: '100%',
};

const headerActionBtn: React.CSSProperties = {
  flexShrink: 0,
  background: chat.colors.bgHover,
  border: `1px solid ${chat.colors.border}`,
  color: chat.colors.textSecondary,
  borderRadius: chat.radius.sm,
  padding: '6px 12px',
  cursor: 'pointer',
  fontSize: 12,
  fontFamily: 'inherit',
};

const offlineBox: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 48,
  gap: 12,
};

const offlineIcon: React.CSSProperties = {
  fontSize: 32,
  opacity: 0.5,
};

const offlineText: React.CSSProperties = {
  color: chat.colors.textSecondary,
  fontSize: 14,
  margin: 0,
  textAlign: 'center',
  maxWidth: 360,
  lineHeight: 1.5,
};
