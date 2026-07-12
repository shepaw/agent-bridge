import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import type { PeerAttachment } from '../api/types.js';

interface AttachmentsPanelProps {
  instanceId: string;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentsPanel({ instanceId }: AttachmentsPanelProps) {
  const [attachments, setAttachments] = useState<PeerAttachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (mode: 'initial' | 'manual' = 'initial') => {
    if (mode === 'manual') setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const { attachments: items } = await api.attachments.list(instanceId);
      setAttachments(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [instanceId]);

  useEffect(() => {
    void load('initial');
  }, [load]);

  const removeOne = async (name: string) => {
    if (!confirm(`删除附件「${name}」？`)) return;
    setBusyName(name);
    setError(null);
    try {
      await api.attachments.remove(instanceId, name);
      setAttachments((prev) => prev.filter((a) => a.name !== name));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyName(null);
    }
  };

  const clearAll = async () => {
    if (attachments.length === 0) return;
    if (!confirm(`清空全部 ${attachments.length} 个附件？此操作不可恢复。`)) return;
    setClearing(true);
    setError(null);
    try {
      await api.attachments.clear(instanceId);
      setAttachments([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setClearing(false);
    }
  };

  const totalBytes = attachments.reduce((sum, a) => sum + a.size, 0);

  return (
    <div>
      <div style={toolbar}>
        <span style={{ color: '#a6adc8', fontSize: 12 }}>
          {loading
            ? '加载中…'
            : `${attachments.length} 个附件 · ${formatBytes(totalBytes)}`}
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            style={{
              ...secondaryBtn,
              opacity: attachments.length === 0 || clearing ? 0.5 : 1,
            }}
            disabled={attachments.length === 0 || clearing || loading}
            onClick={() => void clearAll()}
          >
            {clearing ? '清空中…' : '清空全部'}
          </button>
          <button
            type="button"
            style={{
              ...refreshBtn,
              opacity: refreshing ? 0.65 : 1,
            }}
            disabled={loading || refreshing}
            onClick={() => void load('manual')}
          >
            刷新
          </button>
        </div>
      </div>

      {error && <p style={errorText}>{error}</p>}

      {loading ? (
        <p style={hint}>正在读取 peer-attachments…</p>
      ) : attachments.length === 0 ? (
        <p style={hint}>
          暂无附件。手机端经 Peer 推送的文件会保存在本实例的 <code style={code}>peer-attachments/</code> 目录。
        </p>
      ) : (
        <div style={table}>
          <div style={headerRow}>
            <span style={th}>文件名</span>
            <span style={th}>大小</span>
            <span style={th}>更新时间</span>
            <span style={th} />
          </div>
          {attachments.map((item) => (
            <div key={item.name} style={row}>
              <div style={nameCell}>
                <span style={{ color: '#cdd6f4', fontSize: 13 }}>{item.fileName}</span>
                {item.fileName !== item.name && (
                  <code style={diskName}>{item.name}</code>
                )}
              </div>
              <span style={{ fontSize: 12, color: '#a6adc8' }}>{formatBytes(item.size)}</span>
              <span style={{ fontSize: 12, color: '#a6adc8' }}>
                {new Date(item.modifiedAt).toLocaleString()}
              </span>
              <button
                type="button"
                style={removeBtn}
                disabled={busyName === item.name || clearing}
                onClick={() => void removeOne(item.name)}
              >
                {busyName === item.name ? '…' : '删除'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const toolbar: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 14,
  gap: 12,
  flexWrap: 'wrap',
};

const refreshBtn: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid #89b4fa',
  color: '#89b4fa',
  borderRadius: 4,
  padding: '4px 12px',
  cursor: 'pointer',
  fontSize: 12,
};

const secondaryBtn: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid #f38ba8',
  color: '#f38ba8',
  borderRadius: 4,
  padding: '4px 12px',
  cursor: 'pointer',
  fontSize: 12,
};

const errorText: React.CSSProperties = {
  color: '#f38ba8',
  fontSize: 13,
  margin: '0 0 12px',
};

const hint: React.CSSProperties = {
  color: '#a6adc8',
  fontSize: 14,
  margin: 0,
  lineHeight: 1.5,
};

const code: React.CSSProperties = {
  background: '#313244',
  padding: '1px 6px',
  borderRadius: 4,
  fontSize: 12,
  color: '#cba6f7',
};

const table: React.CSSProperties = {
  border: '1px solid #313244',
  borderRadius: 8,
  overflow: 'hidden',
};

const headerRow: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) 88px 160px 72px',
  gap: 12,
  padding: '8px 14px',
  background: '#1e1e2e',
  borderBottom: '1px solid #313244',
};

const row: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) 88px 160px 72px',
  gap: 12,
  padding: '10px 14px',
  alignItems: 'center',
  borderBottom: '1px solid #313244',
  background: '#11111b',
};

const th: React.CSSProperties = {
  color: '#6c7086',
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: 0.4,
};

const nameCell: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  minWidth: 0,
};

const diskName: React.CSSProperties = {
  fontSize: 11,
  color: '#6c7086',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const removeBtn: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid #f38ba8',
  color: '#f38ba8',
  borderRadius: 4,
  padding: '2px 10px',
  cursor: 'pointer',
  fontSize: 12,
  justifySelf: 'end',
};
