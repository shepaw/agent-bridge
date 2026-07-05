import { useConversations } from '../hooks/useConversations.js';
import type { InstanceStatus } from '../api/types.js';
import { SessionList } from './SessionList.js';
import { SessionTranscript } from './SessionTranscript.js';

interface SessionsPanelProps {
  instanceId: string;
  status: InstanceStatus;
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string | null) => void;
  onManageMappings?: () => void;
}

export function SessionsPanel({
  instanceId,
  status,
  selectedSessionId,
  onSelectSession,
  onManageMappings,
}: SessionsPanelProps) {
  const {
    sessions,
    listLoading,
    listRefreshing,
    listError,
    messages,
    historyLoading,
    historyError,
    gatewayReady,
    loadSessions,
  } = useConversations({
    instanceId,
    status,
    selectedSessionId,
    onSelectSession,
  });

  const offlineMessage =
    status.availability === 'starting'
      ? 'Gateway is starting… Sessions will appear once the agent is online.'
      : 'Start the instance to view sessions.';

  return (
    <div style={wrapper}>
      <div style={toolbar}>
        <span style={{ color: '#a6adc8', fontSize: 12 }}>
          {gatewayReady
            ? `${sessions.length} session${sessions.length === 1 ? '' : 's'}`
            : status.availability}
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          {onManageMappings !== undefined && (
            <button type="button" style={linkBtn} onClick={onManageMappings}>
              Manage mappings
            </button>
          )}
          <button
            type="button"
            style={{
              ...refreshBtn,
              opacity: listRefreshing ? 0.65 : 1,
            }}
            disabled={!gatewayReady || listLoading}
            onClick={() => void loadSessions('manual')}
          >
            Refresh
          </button>
        </div>
      </div>

      {!gatewayReady ? (
        <div style={offlineBox}>
          <p style={offlineText}>{offlineMessage}</p>
        </div>
      ) : (
        <div style={split}>
          <div style={listPane}>
            <SessionList
              sessions={sessions}
              selectedSessionId={selectedSessionId}
              loading={listLoading}
              error={listError}
              onSelect={onSelectSession}
            />
          </div>
          <div style={transcriptPane}>
            <SessionTranscript
              sessionId={selectedSessionId}
              messages={messages}
              loading={historyLoading}
              error={historyError}
            />
          </div>
        </div>
      )}
    </div>
  );
}

const wrapper: React.CSSProperties = {
  background: '#11111b',
  border: '1px solid #313244',
  borderRadius: 8,
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  height: 420,
};

const toolbar: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '6px 12px',
  background: '#1e1e2e',
  borderBottom: '1px solid #313244',
};

const split: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(200px, 34%) 1fr',
  flex: 1,
  minHeight: 0,
};

const listPane: React.CSSProperties = {
  borderRight: '1px solid #313244',
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  overflow: 'hidden',
};

const transcriptPane: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  overflow: 'hidden',
  background: '#181825',
};

const offlineBox: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
};

const offlineText: React.CSSProperties = {
  color: '#a6adc8',
  fontSize: 13,
  margin: 0,
  textAlign: 'center',
};

const refreshBtn: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid #45475a',
  color: '#a6adc8',
  borderRadius: 4,
  padding: '2px 10px',
  minWidth: 64,
  cursor: 'pointer',
  fontSize: 12,
};

const linkBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#89b4fa',
  cursor: 'pointer',
  fontSize: 12,
  padding: '2px 4px',
};
