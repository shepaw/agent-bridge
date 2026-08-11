import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, getHubAuthToken } from '../api/client.js';
import type { StoreEntry, StoreHealth, StoreMapping } from '../api/types.js';

export interface StoreBrowserPanelProps {
  /** Initial URI from hash / instance jump. */
  initialUri?: string | null;
  /** Called when the browsed URI changes (for hash sync). */
  onUriChange?: (uri: string | null) => void;
}

function entryName(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || path;
}

function entryUri(space: string, device: string, path: string): string {
  if (!path) return `store://${space}/${device}/`;
  return `store://${space}/${device}/${path.replace(/^\/+|\/+$/g, '')}`;
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function looksTexty(name: string, bytes: Uint8Array): boolean {
  const lower = name.toLowerCase();
  if (/\.(txt|md|json|jsonl|ya?ml|toml|ts|tsx|js|jsx|mjs|cjs|css|html|xml|svg|py|rs|go|sh|env|log|csv)$/.test(lower)) {
    return true;
  }
  const sample = bytes.subarray(0, Math.min(bytes.length, 512));
  let odd = 0;
  for (const b of sample) {
    if (b === 0) return false;
    if (b < 7 || (b > 14 && b < 32)) odd += 1;
  }
  return odd / Math.max(sample.length, 1) < 0.1;
}

export function StoreBrowserPanel({ initialUri, onUriChange }: StoreBrowserPanelProps) {
  const [health, setHealth] = useState<StoreHealth | null>(null);
  const [mappings, setMappings] = useState<StoreMapping[]>([]);
  const [uri, setUri] = useState<string | null>(initialUri ?? null);
  const [entries, setEntries] = useState<StoreEntry[]>([]);
  const [parent, setParent] = useState<string | null>(null);
  const [selected, setSelected] = useState<StoreEntry | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewBinary, setPreviewBinary] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newContent, setNewContent] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [copied, setCopied] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const initialApplied = useRef(false);

  const navigate = useCallback((next: string | null) => {
    setUri(next);
    setSelected(null);
    setPreview(null);
    setPreviewBinary(false);
    onUriChange?.(next);
  }, [onUriChange]);

  // Apply external initialUri (e.g. hash jump) once / when it changes from outside.
  useEffect(() => {
    if (initialUri === undefined) return;
    if (!initialApplied.current) {
      initialApplied.current = true;
      if (initialUri) setUri(initialUri);
      return;
    }
    setUri(initialUri);
  }, [initialUri]);

  const refreshMeta = useCallback(async () => {
    const [h, m] = await Promise.all([api.store.health(), api.store.mappings()]);
    setHealth(h);
    setMappings(m.mappings);
  }, []);

  const loadList = useCallback(async (target: string | null) => {
    setLoading(true);
    setErr(null);
    setSelected(null);
    setPreview(null);
    try {
      await refreshMeta();
      if (!target) {
        setEntries([]);
        setParent(null);
        return;
      }
      const data = await api.store.list(target, 1);
      setEntries(data.entries);
      setParent(data.parent);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setEntries([]);
      setParent(null);
    } finally {
      setLoading(false);
    }
  }, [refreshMeta]);

  useEffect(() => {
    void loadList(uri);
  }, [uri, loadList]);

  const spaceRoots = useMemo(() => {
    if (!health) return [];
    return health.spaces.map((space) => ({
      space,
      uri: `store://${space}/${health.deviceId}/`,
    }));
  }, [health]);

  const openEntry = async (entry: StoreEntry) => {
    if (!health || !uri) return;
    const parsed = parseCurrent(uri);
    if (!parsed) return;
    const nextUri = entryUri(parsed.space, parsed.device, entry.path);
    if (entry.kind === 'dir' || (!entry.kind && entry.size === 0 && !entry.sha256)) {
      navigate(nextUri.endsWith('/') ? nextUri : `${nextUri}/`);
      return;
    }
    // Heuristic: treat as dir if path has no extension and sha empty — already handled.
    if (entry.kind === 'file' || entry.sha256) {
      setSelected(entry);
      setBusy(true);
      setErr(null);
      try {
        const data = await api.store.read(nextUri);
        const bytes = Uint8Array.from(atob(data.contentBase64), (c) => c.charCodeAt(0));
        const name = entryName(entry.path);
        if (looksTexty(name, bytes)) {
          setPreview(new TextDecoder().decode(bytes));
          setPreviewBinary(false);
        } else {
          setPreview(`二进制文件 · ${formatSize(data.size)} · SHA256 ${data.sha256.slice(0, 12)}…`);
          setPreviewBinary(true);
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
        setPreview(null);
      } finally {
        setBusy(false);
      }
    } else {
      navigate(nextUri.endsWith('/') ? nextUri : `${nextUri}/`);
    }
  };

  const deleteSelected = async () => {
    if (!selected || !uri) return;
    const parsed = parseCurrent(uri);
    if (!parsed) return;
    const target = entryUri(parsed.space, parsed.device, selected.path);
    if (!confirm(`确定删除？\n${target}`)) return;
    setBusy(true);
    setErr(null);
    try {
      await api.store.remove(target);
      setSelected(null);
      setPreview(null);
      await loadList(uri);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const createFile = async () => {
    if (!uri || !newName.trim()) return;
    const parsed = parseCurrent(uri);
    if (!parsed) return;
    const base = parsed.path ? `${parsed.path}/` : '';
    const filePath = `${base}${newName.trim().replace(/^\/+/, '')}`;
    const target = entryUri(parsed.space, parsed.device, filePath);
    setBusy(true);
    setErr(null);
    try {
      await api.store.write({ uri: target, content: newContent });
      setShowNew(false);
      setNewName('');
      setNewContent('');
      await loadList(uri);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const uploadFile = async (file: File) => {
    if (!uri) return;
    const parsed = parseCurrent(uri);
    if (!parsed) return;
    const base = parsed.path ? `${parsed.path}/` : '';
    const filePath = `${base}${file.name}`;
    const target = entryUri(parsed.space, parsed.device, filePath);
    setBusy(true);
    setErr(null);
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
      const contentBase64 = btoa(binary);
      await api.store.write({ uri: target, contentBase64 });
      await loadList(uri);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const copyUri = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  };

  const downloadSelected = async () => {
    if (!selected || !uri) return;
    const parsed = parseCurrent(uri);
    if (!parsed) return;
    const target = entryUri(parsed.space, parsed.device, selected.path);
    setBusy(true);
    try {
      const data = await api.store.read(target);
      const bytes = Uint8Array.from(atob(data.contentBase64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes]);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = entryName(selected.path);
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={panel}>
      {err && /unauthorized|SHEPAW_HUB_TOKEN/i.test(err) && (
        <p style={warn}>需要 Dashboard Token（当前：{getHubAuthToken() ? '已配置但仍无效' : '未配置'}）。</p>
      )}
      {err && !/unauthorized|SHEPAW_HUB_TOKEN/i.test(err) && (
        <p style={{ color: '#f38ba8', fontSize: 13, margin: '0 0 12px' }}>{err}</p>
      )}

      {!uri && (
        <>
          <section style={card}>
            <h3 style={cardTitle}>Space 快捷入口</h3>
            <p style={cardHint}>
              本机储物袋根目录
              {health ? <code style={code}> {health.storeRoot}</code> : null}
              。选择 space 开始浏览。
            </p>
            <div style={chipRow}>
              {spaceRoots.map((s) => (
                <button key={s.space} type="button" style={chipBtn} onClick={() => navigate(s.uri)}>
                  {s.space}
                </button>
              ))}
            </div>
          </section>

          <section style={card}>
            <h3 style={cardTitle}>实例映射</h3>
            <p style={cardHint}>每个实例自动映射 Working Directory 与私有 agents 目录。</p>
            {mappings.length === 0 ? (
              <p style={muted}>暂无实例映射。</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {mappings.map((m) => (
                  <div key={m.instanceId} style={mappingRow}>
                    <div style={{ minWidth: 0 }}>
                      <strong style={{ color: '#cdd6f4' }}>{m.label}</strong>
                      <span style={{ color: '#6c7086', fontSize: 12, marginLeft: 8 }}>{m.engine}</span>
                      <div style={uriLine} title={m.workspaceUri}>{m.workspaceUri}</div>
                      <div style={uriLine} title={m.agentUri}>{m.agentUri}</div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
                      <button type="button" style={smallBtn} onClick={() => navigate(m.workspaceUri)}>打开 Workspace</button>
                      <button type="button" style={smallBtn} onClick={() => navigate(m.agentUri)}>打开 Agent</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {uri && (
        <section style={card}>
          <div style={toolbar}>
            <button type="button" style={navBtn} disabled={!parent} onClick={() => navigate(parent)}>
              ↑ 上一级
            </button>            <button type="button" style={navBtn} onClick={() => navigate(null)}>
              首页
            </button>
            <button type="button" style={navBtn} disabled={loading || busy} onClick={() => void loadList(uri)}>
              刷新
            </button>
            <div style={pathDisplay} title={uri}>{uri}</div>
            <button type="button" style={navBtn} onClick={() => void copyUri(uri)}>
              {copied ? '已复制' : '复制 URI'}
            </button>
          </div>

          <div style={actions}>
            <button type="button" style={primaryBtn} disabled={busy} onClick={() => setShowNew((v) => !v)}>
              新建文本
            </button>
            <button type="button" style={secondaryBtn} disabled={busy} onClick={() => fileInputRef.current?.click()}>
              上传文件
            </button>
            <input
              ref={fileInputRef}
              type="file"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void uploadFile(f);
              }}
            />
            {selected && selected.kind !== 'dir' && (
              <>
                <button type="button" style={secondaryBtn} disabled={busy} onClick={() => void downloadSelected()}>
                  下载
                </button>
                <button type="button" style={dangerBtn} disabled={busy} onClick={() => void deleteSelected()}>
                  删除
                </button>
              </>
            )}
          </div>

          {showNew && (
            <div style={newBox}>
              <input
                style={inp}
                placeholder="文件名，如 notes.txt"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
              <textarea
                style={{ ...inp, minHeight: 100, fontFamily: 'ui-monospace, Menlo, monospace' }}
                placeholder="文件内容"
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" style={primaryBtn} disabled={busy || !newName.trim()} onClick={() => void createFile()}>
                  保存
                </button>
                <button type="button" style={secondaryBtn} onClick={() => setShowNew(false)}>取消</button>
              </div>
            </div>
          )}

          <div style={browserSplit}>
            <div style={listBox}>
              {loading && <p style={muted}>加载中…</p>}
              {!loading && entries.length === 0 && <p style={muted}>此目录为空</p>}
              {!loading && entries.map((entry) => {
                const isDir = entry.kind === 'dir' || (!entry.kind && !entry.sha256 && entry.size === 0);
                const active = selected?.path === entry.path;
                return (
                  <div
                    key={entry.path}
                    role="option"
                    aria-selected={active}
                    style={{ ...row, ...(active ? rowActive : {}) }}
                    onClick={() => {
                      if (isDir) {
                        void openEntry({ ...entry, kind: 'dir' });
                      } else {
                        void openEntry({ ...entry, kind: 'file' });
                      }
                    }}
                    onDoubleClick={() => void openEntry({ ...entry, kind: isDir ? 'dir' : 'file' })}
                  >
                    <span style={folderIcon}>{isDir ? '▸' : '·'}</span>
                    <span style={rowName}>{entryName(entry.path)}</span>
                    <span style={rowMeta}>
                      {isDir ? '目录' : formatSize(entry.size)}
                    </span>
                  </div>
                );
              })}
            </div>

            <div style={previewBox}>
              {!selected && <p style={muted}>选择文件以预览</p>}
              {selected && busy && <p style={muted}>读取中…</p>}
              {selected && !busy && preview !== null && (
                previewBinary
                  ? <p style={muted}>{preview}</p>
                  : <pre style={previewPre}>{preview}</pre>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function parseCurrent(uri: string): { space: string; device: string; path: string } | null {
  const m = /^store:\/\/([^/]+)\/([a-f0-9]{16})(?:\/(.*))?$/i.exec(uri.trim());
  if (!m) return null;
  return {
    space: m[1]!,
    device: m[2]!.toLowerCase(),
    path: (m[3] ?? '').replace(/\/+$/, ''),
  };
}

const panel: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 16 };
const card: React.CSSProperties = {
  background: '#1e1e2e', border: '1px solid #313244', borderRadius: 10, padding: '20px 24px',
};
const cardTitle: React.CSSProperties = { margin: '0 0 4px', color: '#cdd6f4', fontSize: 16 };
const cardHint: React.CSSProperties = { margin: '0 0 16px', color: '#a6adc8', fontSize: 13 };
const muted: React.CSSProperties = { color: '#6c7086', fontSize: 13, margin: 12 };
const warn: React.CSSProperties = { color: '#f9e2af', fontSize: 13, margin: '0 0 12px' };
const code: React.CSSProperties = {
  background: '#181825', border: '1px solid #313244', borderRadius: 4, padding: '0 4px', fontSize: 12,
};
const chipRow: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8 };
const chipBtn: React.CSSProperties = {
  background: '#313244', color: '#89b4fa', border: '1px solid #45475a', borderRadius: 6,
  padding: '8px 12px', cursor: 'pointer', fontSize: 13, fontFamily: 'ui-monospace, Menlo, monospace',
};
const mappingRow: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start',
  padding: '10px 12px', background: '#181825', border: '1px solid #313244', borderRadius: 6,
};
const uriLine: React.CSSProperties = {
  color: '#6c7086', fontSize: 11, fontFamily: 'ui-monospace, Menlo, monospace',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 4,
};
const smallBtn: React.CSSProperties = {
  background: 'transparent', color: '#89b4fa', border: '1px solid #45475a', borderRadius: 5,
  padding: '4px 10px', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap',
};
const toolbar: React.CSSProperties = {
  display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap',
};
const navBtn: React.CSSProperties = {
  background: 'transparent', border: '1px solid #45475a', color: '#a6adc8',
  borderRadius: 5, padding: '4px 10px', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap',
};
const pathDisplay: React.CSSProperties = {
  flex: 1, minWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, color: '#cdd6f4',
  background: '#11111b', border: '1px solid #313244', borderRadius: 5, padding: '5px 8px',
};
const actions: React.CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 };
const primaryBtn: React.CSSProperties = {
  background: '#89b4fa', color: '#1e1e2e', border: 'none', borderRadius: 6,
  padding: '6px 14px', cursor: 'pointer', fontWeight: 600, fontSize: 13,
};
const secondaryBtn: React.CSSProperties = {
  background: 'transparent', color: '#cdd6f4', border: '1px solid #45475a', borderRadius: 6,
  padding: '6px 14px', cursor: 'pointer', fontSize: 13,
};
const dangerBtn: React.CSSProperties = {
  background: '#452632', color: '#f38ba8', border: '1px solid #f38ba8', borderRadius: 5,
  padding: '6px 12px', cursor: 'pointer', fontSize: 12,
};
const newBox: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12,
  padding: 12, background: '#181825', border: '1px solid #313244', borderRadius: 6,
};
const inp: React.CSSProperties = {
  background: '#11111b', border: '1px solid #45475a', borderRadius: 5,
  color: '#cdd6f4', padding: '6px 10px', fontSize: 13, outline: 'none', width: '100%', boxSizing: 'border-box',
};
const browserSplit: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) minmax(220px, 1fr)', gap: 12,
};
const listBox: React.CSSProperties = {
  minHeight: 240, maxHeight: 420, overflowY: 'auto',
  background: '#11111b', border: '1px solid #313244', borderRadius: 6,
};
const previewBox: React.CSSProperties = {
  minHeight: 240, maxHeight: 420, overflowY: 'auto',
  background: '#11111b', border: '1px solid #313244', borderRadius: 6, padding: 12,
};
const previewPre: React.CSSProperties = {
  margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
  color: '#cdd6f4', fontSize: 12, fontFamily: 'ui-monospace, Menlo, monospace',
};
const row: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px',
  cursor: 'pointer', borderBottom: '1px solid #1e1e2e', color: '#cdd6f4', fontSize: 13,
};
const rowActive: React.CSSProperties = { background: '#313244', outline: '1px solid #89b4fa66' };
const folderIcon: React.CSSProperties = { flexShrink: 0, color: '#89b4fa', fontSize: 14 };
const rowName: React.CSSProperties = {
  flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12,
};
const rowMeta: React.CSSProperties = { flexShrink: 0, color: '#6c7086', fontSize: 11 };
