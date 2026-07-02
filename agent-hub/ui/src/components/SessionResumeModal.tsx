import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import type { StoredSession } from '../api/types.js';

interface SessionResumeProps {
  instanceId: string;
  onClose: () => void;
}

export function SessionResumeModal({ instanceId, onClose }: SessionResumeProps) {
  const [sessions, setSessions] = useState<StoredSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const { sessions: list } = await api.sessions.list(instanceId);
      setSessions(list);
      if (list.length === 1) setSelectedId(list[0]!.shepawSessionId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [instanceId]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  const selected = sessions.find((s) => s.shepawSessionId === selectedId);

  const copySessionId = async () => {
    if (selected === undefined) return;
    try {
      await navigator.clipboard.writeText(selected.shepawSessionId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setErr('Failed to copy to clipboard');
    }
  };

  const removeSession = async (shepawSessionId: string) => {
    setDeleting(shepawSessionId);
    setErr(null);
    try {
      await api.sessions.remove(instanceId, shepawSessionId);
      setSessions((prev) => prev.filter((s) => s.shepawSessionId !== shepawSessionId));
      if (selectedId === shepawSessionId) setSelectedId(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <h3 style={{ margin: 0, color: '#cdd6f4' }}>Resume Session — {instanceId}</h3>
          <button style={closeBtn} onClick={onClose}>✕</button>
        </div>

        <div style={body}>
          <p style={{ color: '#a6adc8', fontSize: 13, margin: '0 0 12px' }}>
            These are persisted Shepaw session IDs mapped to upstream ACP sessions.
            In the Shepaw app, start a chat with the same session ID to continue
            where you left off after a gateway restart.
          </p>

          {loading && <p style={{ color: '#a6adc8', fontSize: 13 }}>Loading sessions…</p>}
          {err && <p style={{ color: '#f38ba8', margin: '8px 0' }}>{err}</p>}

          {!loading && sessions.length === 0 && !err && (
            <p style={{ color: '#a6adc8', fontSize: 13 }}>
              No saved sessions yet. Mappings appear here after you chat from the Shepaw app.
            </p>
          )}

          {!loading && sessions.length > 0 && (
            <div style={table}>
              <div style={rowHeader}>
                <span style={th}>SHEPAW SESSION</span>
                <span style={th}>ACP SESSION</span>
                <span style={th} />
              </div>
              {sessions.map((s) => (
                <div
                  key={s.shepawSessionId}
                  style={{
                    ...row,
                    background: selectedId === s.shepawSessionId ? '#313244' : 'transparent',
                  }}
                  onClick={() => setSelectedId(s.shepawSessionId)}
                >
                  <code style={cellCode}>{s.shepawSessionId}</code>
                  <code style={{ ...cellCode, color: '#a6adc8' }}>{s.acpSessionId}</code>
                  <button
                    style={removeBtn}
                    disabled={deleting === s.shepawSessionId}
                    onClick={(e) => {
                      e.stopPropagation();
                      void removeSession(s.shepawSessionId);
                    }}
                  >
                    {deleting === s.shepawSessionId ? '…' : 'Remove'}
                  </button>
                </div>
              ))}
            </div>
          )}

          {selected !== undefined && (
            <div style={detailBox}>
              <p style={{ color: '#cdd6f4', fontSize: 13, margin: '0 0 8px' }}>
                Use this session ID in the Shepaw app:
              </p>
              <code style={highlightCode}>{selected.shepawSessionId}</code>
              <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                <button type="button" style={submitBtn} onClick={() => void copySessionId()}>
                  {copied ? 'Copied!' : 'Copy Session ID'}
                </button>
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button type="button" style={cancelBtn} onClick={() => void loadSessions()} disabled={loading}>
              Refresh
            </button>
            <button type="button" style={cancelBtn} onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0,
  background: 'rgba(0,0,0,0.6)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 100,
};

const modal: React.CSSProperties = {
  background: '#1e1e2e', border: '1px solid #45475a',
  borderRadius: 10, width: '90%', maxWidth: 640,
};

const header: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  padding: '14px 20px', borderBottom: '1px solid #313244',
};

const body: React.CSSProperties = { padding: 20 };

const closeBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', color: '#a6adc8', fontSize: 18, cursor: 'pointer',
};

const table: React.CSSProperties = {
  border: '1px solid #313244', borderRadius: 6, overflow: 'hidden', marginBottom: 12,
};

const rowHeader: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: '1fr 1fr 72px',
  gap: 8, padding: '8px 12px', background: '#11111b',
};

const row: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: '1fr 1fr 72px',
  gap: 8, padding: '8px 12px', cursor: 'pointer', borderTop: '1px solid #313244',
};

const th: React.CSSProperties = { color: '#6c7086', fontSize: 11, fontWeight: 600 };

const cellCode: React.CSSProperties = { fontSize: 12, color: '#cdd6f4', wordBreak: 'break-all' };

const removeBtn: React.CSSProperties = {
  background: 'transparent', border: '1px solid #45475a', color: '#f38ba8',
  borderRadius: 4, padding: '2px 6px', fontSize: 11, cursor: 'pointer',
};

const detailBox: React.CSSProperties = {
  background: '#11111b', borderRadius: 6, padding: 12, marginTop: 8,
};

const highlightCode: React.CSSProperties = {
  display: 'block', fontSize: 13, color: '#a6e3a1', wordBreak: 'break-all',
};

const submitBtn: React.CSSProperties = {
  background: '#89b4fa', color: '#11111b', border: 'none',
  borderRadius: 6, padding: '7px 18px', cursor: 'pointer', fontWeight: 600,
};

const cancelBtn: React.CSSProperties = {
  background: 'transparent', border: '1px solid #45475a', color: '#a6adc8',
  borderRadius: 6, padding: '7px 18px', cursor: 'pointer',
};
