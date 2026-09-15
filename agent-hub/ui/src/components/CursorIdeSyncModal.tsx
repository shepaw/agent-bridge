import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import type { CursorIdeSyncPreview } from '../api/types.js';
import { useI18n } from '../i18n/index.js';

interface CursorIdeSyncModalProps {
  instanceId: string;
  onClose: () => void;
  onSynced?: () => void;
}

export function CursorIdeSyncModal({ instanceId, onClose, onSynced }: CursorIdeSyncModalProps) {
  const { t } = useI18n();
  const [preview, setPreview] = useState<CursorIdeSyncPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [resultMsg, setResultMsg] = useState<string | null>(null);

  const loadPreview = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const data = await api.cursorIde.preview(instanceId);
      setPreview(data);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [instanceId]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  const runSync = async () => {
    setSyncing(true);
    setErr(null);
    setResultMsg(null);
    try {
      const result = await api.cursorIde.sync(instanceId);
      setResultMsg(
        t('cursorIde.syncDone', {
          added: result.added,
          updated: result.updated,
          total: result.total,
        }),
      );
      await loadPreview();
      onSynced?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <h3 style={{ margin: 0, color: '#cdd6f4' }}>{t('cursorIde.title')}</h3>
          <button type="button" style={closeBtn} onClick={onClose}>✕</button>
        </div>

        <div style={body}>
          <p style={hint}>{t('cursorIde.hint')}</p>

          {loading && <p style={muted}>{t('cursorIde.loading')}</p>}
          {err && <p style={errorText}>{err}</p>}
          {resultMsg && <p style={okText}>{resultMsg}</p>}

          {preview !== null && !loading && (
            <>
              <p style={muted}>
                {t('cursorIde.workspace', { cwd: preview.cwd, slug: preview.workspaceSlug })}
              </p>
              <div style={statsRow}>
                <span style={stat}>{t('cursorIde.onDisk', { count: preview.onDisk.length })}</span>
                <span style={stat}>{t('cursorIde.synced', { count: preview.synced.length })}</span>
                <span style={stat}>{t('cursorIde.pending', { count: preview.pending.length })}</span>
              </div>

              {preview.pending.length > 0 ? (
                <ul style={list}>
                  {preview.pending.slice(0, 12).map((s) => (
                    <li key={s.sessionId} style={listItem}>
                      <span style={title}>{s.title}</span>
                      <span style={meta}>{s.messageCount} {t('cursorIde.messages')}</span>
                    </li>
                  ))}
                  {preview.pending.length > 12 && (
                    <li style={muted}>{t('cursorIde.more', { count: preview.pending.length - 12 })}</li>
                  )}
                </ul>
              ) : (
                <p style={muted}>{t('cursorIde.noPending')}</p>
              )}
            </>
          )}
        </div>

        <div style={footer}>
          <button type="button" style={secondaryBtn} onClick={onClose} disabled={syncing}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            style={{
              ...primaryBtn,
              opacity: syncing || (preview?.pending.length ?? 0) === 0 ? 0.55 : 1,
            }}
            disabled={syncing || loading || (preview?.pending.length ?? 0) === 0}
            onClick={() => void runSync()}
          >
            {syncing ? t('cursorIde.syncing') : t('cursorIde.syncBtn', { count: preview?.pending.length ?? 0 })}
          </button>
        </div>
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.55)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
};

const modal: React.CSSProperties = {
  background: '#1e1e2e',
  border: '1px solid #45475a',
  borderRadius: 10,
  width: 'min(520px, 92vw)',
  maxHeight: '80vh',
  display: 'flex',
  flexDirection: 'column',
};

const header: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '14px 16px',
  borderBottom: '1px solid #313244',
};

const body: React.CSSProperties = {
  padding: '12px 16px',
  overflow: 'auto',
  flex: 1,
};

const footer: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
  padding: '12px 16px',
  borderTop: '1px solid #313244',
};

const hint: React.CSSProperties = { color: '#a6adc8', fontSize: 13, margin: '0 0 12px' };
const muted: React.CSSProperties = { color: '#6c7086', fontSize: 12, margin: '8px 0' };
const errorText: React.CSSProperties = { color: '#f38ba8', fontSize: 13 };
const okText: React.CSSProperties = { color: '#a6e3a1', fontSize: 13 };

const statsRow: React.CSSProperties = {
  display: 'flex',
  gap: 12,
  flexWrap: 'wrap',
  marginBottom: 10,
};

const stat: React.CSSProperties = {
  fontSize: 12,
  color: '#bac2de',
  background: '#181825',
  padding: '4px 8px',
  borderRadius: 4,
};

const list: React.CSSProperties = {
  margin: 0,
  padding: '0 0 0 18px',
  maxHeight: 220,
  overflow: 'auto',
};

const listItem: React.CSSProperties = {
  marginBottom: 6,
  fontSize: 12,
};

const title: React.CSSProperties = { color: '#cdd6f4', display: 'block' };
const meta: React.CSSProperties = { color: '#6c7086', fontSize: 11 };

const closeBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#a6adc8',
  cursor: 'pointer',
  fontSize: 16,
};

const secondaryBtn: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid #45475a',
  color: '#cdd6f4',
  borderRadius: 6,
  padding: '6px 14px',
  cursor: 'pointer',
  fontSize: 13,
};

const primaryBtn: React.CSSProperties = {
  background: '#89b4fa',
  border: 'none',
  color: '#1e1e2e',
  borderRadius: 6,
  padding: '6px 14px',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
};
