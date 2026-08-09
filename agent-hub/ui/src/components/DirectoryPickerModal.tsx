import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import type { FsBrowseEntry, FsBrowseResult } from '../api/types.js';

interface DirectoryPickerModalProps {
  /** Optional starting path (e.g. current cwd). Empty → Hub home. */
  initialPath?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

export function DirectoryPickerModal({
  initialPath,
  onSelect,
  onClose,
}: DirectoryPickerModalProps) {
  const [result, setResult] = useState<FsBrowseResult | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (path?: string, opts?: { softFallback?: boolean }) => {
    setLoading(true);
    setErr(null);
    setNotice(null);
    setSelected(null);
    try {
      const data = await api.fs.browse(path);
      setResult(data);
      setSelected(data.path);
    } catch (ex) {
      const message = ex instanceof Error ? ex.message : String(ex);
      if (opts?.softFallback && path !== undefined && path.trim().length > 0) {
        // Typed cwd may not exist yet — fall back to home.
        try {
          const data = await api.fs.browse(undefined);
          setResult(data);
          setSelected(data.path);
          setNotice(`无法打开「${path.trim()}」，已回到 Home。`);
          return;
        } catch (homeEx) {
          setResult(null);
          setErr(homeEx instanceof Error ? homeEx.message : String(homeEx));
          return;
        }
      }
      setResult(null);
      setErr(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const start = initialPath?.trim();
    void load(start && start.length > 0 ? start : undefined, { softFallback: true });
  }, [initialPath, load]);

  const enter = (entry: FsBrowseEntry) => {
    void load(entry.path);
  };

  const goUp = () => {
    if (result?.parent) void load(result.parent);
  };

  const confirm = () => {
    const path = selected ?? result?.path;
    if (path) onSelect(path);
  };

  const canConfirm = !loading && !err && Boolean(selected ?? result?.path);

  return (
    <div style={overlay} onClick={onClose}>
      <div
        style={modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dir-picker-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div style={header}>
          <h3 id="dir-picker-title" style={{ margin: 0, color: '#cdd6f4', fontSize: 16 }}>
            选择 Working Directory
          </h3>
          <button style={closeBtn} onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>

        <div style={toolbar}>
          <button
            type="button"
            style={navBtn}
            disabled={loading || !result?.parent}
            onClick={goUp}
            title="上一级"
          >
            ↑ 上一级
          </button>
          <div style={pathDisplay} title={result?.path ?? ''}>
            {result?.path ?? (loading ? '加载中…' : '—')}
          </div>
        </div>

        {notice && (
          <p style={noticeText}>{notice}</p>
        )}

        <div style={listBox}>
          {loading && (
            <p style={{ color: '#6c7086', fontSize: 13, margin: 12 }}>加载中…</p>
          )}
          {!loading && err && (
            <div style={{ padding: 12 }}>
              <p style={{ color: '#f38ba8', fontSize: 13, margin: '0 0 8px' }}>{err}</p>
              <button
                type="button"
                style={navBtn}
                onClick={() => void load(undefined)}
              >
                回到 Home
              </button>
            </div>
          )}
          {!loading && !err && result && result.entries.length === 0 && (
            <p style={{ color: '#6c7086', fontSize: 13, margin: 12 }}>此目录下没有子文件夹</p>
          )}
          {!loading && !err && result && result.entries.map((entry) => {
            const isSelected = selected === entry.path;
            return (
              <div
                key={entry.path}
                role="option"
                aria-selected={isSelected}
                style={{
                  ...row,
                  ...(isSelected ? rowSelected : {}),
                }}
                onClick={() => setSelected(entry.path)}
                onDoubleClick={() => enter(entry)}
              >
                <span style={folderIcon}>▸</span>
                <span style={rowName}>{entry.name}</span>
              </div>
            );
          })}
        </div>

        <p style={hint}>单击选中，双击进入子目录。确认后将使用当前选中路径。</p>

        {result && (
          <p style={selectedPath}>
            将选择：<code style={code}>{selected ?? result.path}</code>
          </p>
        )}

        <div style={footer}>
          <button type="button" style={cancelBtn} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            style={confirmBtn}
            disabled={!canConfirm}
            onClick={confirm}
          >
            选择此文件夹
          </button>
        </div>
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.6)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 110,
};

const modal: React.CSSProperties = {
  background: '#1e1e2e',
  border: '1px solid #45475a',
  borderRadius: 10,
  width: '90%',
  maxWidth: 520,
  maxHeight: '85vh',
  display: 'flex',
  flexDirection: 'column',
  boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
};

const header: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '14px 16px',
  borderBottom: '1px solid #313244',
  flexShrink: 0,
};

const closeBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#a6adc8',
  fontSize: 18,
  cursor: 'pointer',
};

const toolbar: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'center',
  padding: '10px 16px',
  borderBottom: '1px solid #313244',
  flexShrink: 0,
};

const navBtn: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid #45475a',
  color: '#a6adc8',
  borderRadius: 5,
  padding: '4px 10px',
  cursor: 'pointer',
  fontSize: 12,
  whiteSpace: 'nowrap',
  flexShrink: 0,
};

const pathDisplay: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
  color: '#cdd6f4',
  background: '#11111b',
  border: '1px solid #313244',
  borderRadius: 5,
  padding: '5px 8px',
};

const noticeText: React.CSSProperties = {
  margin: '8px 16px 0',
  color: '#fab387',
  fontSize: 12,
  flexShrink: 0,
};

const listBox: React.CSSProperties = {
  flex: 1,
  minHeight: 200,
  maxHeight: 360,
  overflowY: 'auto',
  background: '#11111b',
  margin: '0 16px',
  marginTop: 12,
  border: '1px solid #313244',
  borderRadius: 6,
};

const row: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '7px 10px',
  cursor: 'pointer',
  borderBottom: '1px solid #1e1e2e',
  color: '#cdd6f4',
  fontSize: 13,
};

const rowSelected: React.CSSProperties = {
  background: '#313244',
  outline: '1px solid #89b4fa66',
};

const folderIcon: React.CSSProperties = {
  flexShrink: 0,
  fontSize: 14,
  lineHeight: 1,
  color: '#89b4fa',
};

const rowName: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const hint: React.CSSProperties = {
  margin: '8px 16px 0',
  color: '#6c7086',
  fontSize: 11,
  flexShrink: 0,
};

const selectedPath: React.CSSProperties = {
  margin: '6px 16px 0',
  color: '#a6adc8',
  fontSize: 12,
  flexShrink: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const code: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  color: '#a6e3a1',
  fontSize: 12,
};

const footer: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 10,
  padding: '14px 16px',
  borderTop: '1px solid #313244',
  marginTop: 12,
  flexShrink: 0,
};

const cancelBtn: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid #45475a',
  color: '#a6adc8',
  borderRadius: 6,
  padding: '7px 16px',
  cursor: 'pointer',
};

const confirmBtn: React.CSSProperties = {
  background: '#89b4fa',
  color: '#11111b',
  border: 'none',
  borderRadius: 6,
  padding: '7px 16px',
  cursor: 'pointer',
  fontWeight: 600,
};
