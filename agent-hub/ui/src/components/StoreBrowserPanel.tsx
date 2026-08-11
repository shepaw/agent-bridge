import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, getHubAuthToken } from '../api/client.js';
import type { StoreEntry, StoreMapping, StoreRootsResult } from '../api/types.js';

export interface StoreBrowserPanelProps {
  /** Initial URI from hash / instance jump. */
  initialUri?: string | null;
  /** Called when the browsed URI changes (for hash sync). */
  onUriChange?: (uri: string | null) => void;
}

type SideSelection =
  | { kind: 'local' }
  | { kind: 'peer'; fingerprint: string }
  | { kind: 'agent'; instanceId: string };

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

function parseCurrent(uri: string): { space: string; device: string; path: string } | null {
  const m = /^store:\/\/([^/]+)\/([a-f0-9]{16})(?:\/(.*))?$/i.exec(uri.trim());
  if (!m) return null;
  return {
    space: m[1]!,
    device: m[2]!.toLowerCase(),
    path: (m[3] ?? '').replace(/\/+$/, ''),
  };
}

function spaceLabel(space: string): string {
  const map: Record<string, string> = {
    workspaces: '工作区',
    runtime: '运行时',
    files: '文件',
    public: '公开',
    memory: '记忆',
    artifacts: '产物',
    agents: 'Agent 私有',
    sessions: '会话',
    attachments: '附件',
    backups: '备份',
  };
  return map[space] ?? space;
}

export function StoreBrowserPanel({ initialUri, onUriChange }: StoreBrowserPanelProps) {
  const [roots, setRoots] = useState<StoreRootsResult | null>(null);
  const [side, setSide] = useState<SideSelection>({ kind: 'local' });
  const [uri, setUri] = useState<string | null>(null);
  const [entries, setEntries] = useState<StoreEntry[]>([]);
  const [parent, setParent] = useState<string | null>(null);
  const [writable, setWritable] = useState(true);
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

  const applyUriSelection = useCallback((target: string, rootsData: StoreRootsResult) => {
    const parsed = parseCurrent(target);
    if (!parsed) return;
    if (parsed.device === rootsData.local.deviceId) {
      const agent = rootsData.agents.find((a) =>
        target.startsWith(a.agentUri.replace(/\/+$/, ''))
        || (parsed.space === 'agents' && parsed.path.split('/')[0] === a.instanceId),
      );
      if (agent && (parsed.space === 'agents' || target.startsWith(agent.agentUri.replace(/\/+$/, '')))) {
        setSide({ kind: 'agent', instanceId: agent.instanceId });
      } else {
        setSide({ kind: 'local' });
      }
    } else {
      const peer = rootsData.peers.find((p) => p.fingerprint === parsed.device);
      if (peer) setSide({ kind: 'peer', fingerprint: peer.fingerprint });
      else setSide({ kind: 'local' });
    }
  }, []);

  const loadRoots = useCallback(async () => {
    const data = await api.store.roots();
    setRoots(data);
    return data;
  }, []);

  const loadList = useCallback(async (target: string | null) => {
    setLoading(true);
    setErr(null);
    setSelected(null);
    setPreview(null);
    try {
      if (!target) {
        setEntries([]);
        setParent(null);
        setWritable(side.kind === 'local' || side.kind === 'agent');
        return;
      }
      const data = await api.store.list(target, 1);
      setEntries(data.entries);
      setParent(data.parent);
      setWritable(data.writable !== false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setEntries([]);
      setParent(null);
    } finally {
      setLoading(false);
    }
  }, [side.kind]);

  // Bootstrap roots + optional deep-link URI
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await loadRoots();
        if (cancelled) return;
        if (!initialApplied.current) {
          initialApplied.current = true;
          if (initialUri) {
            applyUriSelection(initialUri, data);
            setUri(initialUri);
            onUriChange?.(initialUri);
          }
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bootstrap once
  }, []);

  // External hash jump
  useEffect(() => {
    if (!initialUri || !roots || !initialApplied.current) return;
    applyUriSelection(initialUri, roots);
    setUri(initialUri);
  }, [initialUri, roots, applyUriSelection]);

  useEffect(() => {
    void loadList(uri);
  }, [uri, loadList]);

  const activePeer = useMemo(() => {
    if (side.kind !== 'peer' || !roots) return null;
    return roots.peers.find((p) => p.fingerprint === side.fingerprint) ?? null;
  }, [side, roots]);

  const activeAgent: StoreMapping | null = useMemo(() => {
    if (side.kind !== 'agent' || !roots) return null;
    return roots.agents.find((a) => a.instanceId === side.instanceId) ?? null;
  }, [side, roots]);

  const spaces = useMemo(() => {
    if (!roots) return [];
    if (side.kind === 'peer') return activePeer?.spaces ?? roots.local.spaces.filter((s) => ['files', 'workspaces', 'public', 'artifacts'].includes(s));
    if (side.kind === 'agent') return [];
    return roots.local.spaces;
  }, [roots, side, activePeer]);

  const breadcrumb = useMemo(() => {
    if (!uri) return [] as { label: string; uri: string | null }[];
    const parsed = parseCurrent(uri);
    if (!parsed) return [];
    const parts = parsed.path ? parsed.path.split('/').filter(Boolean) : [];
    const crumbs: { label: string; uri: string | null }[] = [
      { label: '分区', uri: null },
      { label: spaceLabel(parsed.space), uri: entryUri(parsed.space, parsed.device, '') },
    ];
    let acc = '';
    for (const seg of parts) {
      acc = acc ? `${acc}/${seg}` : seg;
      crumbs.push({ label: seg, uri: entryUri(parsed.space, parsed.device, acc) });
    }
    return crumbs;
  }, [uri]);

  const selectLocal = () => {
    setSide({ kind: 'local' });
    navigate(null);
  };

  const selectPeer = (fingerprint: string) => {
    setSide({ kind: 'peer', fingerprint });
    navigate(null);
  };

  const selectAgent = (agent: StoreMapping) => {
    setSide({ kind: 'agent', instanceId: agent.instanceId });
    navigate(agent.agentUri);
  };

  const openSpace = (space: string) => {
    if (!roots) return;
    const device = side.kind === 'peer'
      ? side.fingerprint
      : roots.local.deviceId;
    navigate(entryUri(space, device, ''));
  };

  const openEntry = async (entry: StoreEntry) => {
    if (!uri) return;
    const parsed = parseCurrent(uri);
    if (!parsed) return;
    const nextUri = entryUri(parsed.space, parsed.device, entry.path);
    const isDir = entry.kind === 'dir' || (!entry.kind && !entry.sha256 && entry.size === 0);
    if (isDir) {
      navigate(nextUri.endsWith('/') ? nextUri : `${nextUri}/`);
      return;
    }
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
  };

  const deleteSelected = async () => {
    if (!selected || !uri || !writable) return;
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
    if (!uri || !newName.trim() || !writable) return;
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
    if (!uri || !writable) return;
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
      await api.store.write({ uri: target, contentBase64: btoa(binary) });
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

  const sideTitle = side.kind === 'local'
    ? '本机'
    : side.kind === 'peer'
      ? (activePeer?.deviceName ?? '配对设备')
      : (activeAgent?.label ?? 'Agent');

  return (
    <div style={shell}>
      <aside style={sideNav}>
        <button
          type="button"
          style={sideItem(side.kind === 'local')}
          onClick={selectLocal}
        >
          <span style={sideIcon}>⌂</span>
          <span>
            <div style={sideLabel}>本机</div>
            <div style={sideSub}>{roots?.local.deviceId.slice(0, 8) ?? '…'} · 可写</div>
          </span>
        </button>

        <div style={sideSection}>配对设备</div>
        {!roots?.peerService.running && (
          <p style={sideHint}>Peer 未启动时仅能看本机镜像；远端实时读取需先开「扫码配对」。</p>
        )}
        {roots?.peers.length === 0 && (
          <p style={sideHint}>暂无配对设备。去「扫码配对」连接手机。</p>
        )}
        {roots?.peers.map((p) => (
          <button
            key={p.fingerprint}
            type="button"
            style={sideItem(side.kind === 'peer' && side.fingerprint === p.fingerprint)}
            onClick={() => selectPeer(p.fingerprint)}
          >
            <span style={sideIcon}>▣</span>
            <span>
              <div style={sideLabel}>{p.deviceName}</div>
              <div style={sideSub}>{p.fingerprint.slice(0, 8)} · 只读共享</div>
            </span>
          </button>
        ))}

        <div style={sideSection}>Agent 储物空间</div>
        {roots?.agents.length === 0 && (
          <p style={sideHint}>暂无实例。创建实例后会自动映射私有 agents 空间。</p>
        )}
        {roots?.agents.map((a) => (
          <button
            key={a.instanceId}
            type="button"
            style={sideItem(side.kind === 'agent' && side.instanceId === a.instanceId)}
            onClick={() => selectAgent(a)}
          >
            <span style={sideIcon}>◈</span>
            <span>
              <div style={sideLabel}>{a.label}</div>
              <div style={sideSub}>{a.engine}</div>
            </span>
          </button>
        ))}
      </aside>

      <main style={mainPane}>
        {err && /unauthorized|SHEPAW_HUB_TOKEN/i.test(err) && (
          <p style={warn}>需要 Dashboard Token（当前：{getHubAuthToken() ? '已配置但仍无效' : '未配置'}）。</p>
        )}
        {err && !/unauthorized|SHEPAW_HUB_TOKEN/i.test(err) && (
          <p style={{ color: '#f38ba8', fontSize: 13, margin: '0 0 12px' }}>{err}</p>
        )}

        <div style={mainHeader}>
          <div>
            <h3 style={mainTitle}>{sideTitle}</h3>
            <p style={mainHint}>
              {side.kind === 'local' && '本机储物袋（网盘分区）。可浏览、上传、新建与删除。'}
              {side.kind === 'peer' && '配对设备共享分区（files / workspaces / public / artifacts），只读。'}
              {side.kind === 'agent' && '该 Agent 的私有储物空间与 Working Directory 映射。'}
            </p>
          </div>
          {!writable && uri && (
            <span style={roBadge}>只读</span>
          )}
        </div>

        {/* Space picker when not inside a path (except agent which lands in agentUri) */}
        {!uri && side.kind !== 'agent' && (
          <div style={spaceGrid}>
            {spaces.map((space) => (
              <button
                key={space}
                type="button"
                style={spaceCard}
                onClick={() => openSpace(space)}
              >
                <div style={spaceName}>{spaceLabel(space)}</div>
                <code style={spaceCode}>{space}</code>
              </button>
            ))}
          </div>
        )}

        {side.kind === 'agent' && activeAgent && !uri && (
          <div style={spaceGrid}>
            <button type="button" style={spaceCard} onClick={() => navigate(activeAgent.agentUri)}>
              <div style={spaceName}>Agent 私有</div>
              <code style={spaceCode}>{activeAgent.agentUri}</code>
            </button>
            <button type="button" style={spaceCard} onClick={() => navigate(activeAgent.workspaceUri)}>
              <div style={spaceName}>Workspace</div>
              <code style={spaceCode}>{activeAgent.workspaceUri}</code>
            </button>
          </div>
        )}

        {side.kind === 'agent' && activeAgent && uri && (
          <div style={agentJumpRow}>
            <button
              type="button"
              style={chipBtn(uri.startsWith(activeAgent.agentUri.replace(/\/+$/, '')))}
              onClick={() => navigate(activeAgent.agentUri)}
            >
              Agent 私有
            </button>
            <button
              type="button"
              style={chipBtn(uri.startsWith(activeAgent.workspaceUri.replace(/\/+$/, '')))}
              onClick={() => navigate(activeAgent.workspaceUri)}
            >
              Workspace
            </button>
          </div>
        )}

        {uri && (
          <>
            <div style={crumbRow}>
              {breadcrumb.map((c, i) => (
                <span key={`${c.label}-${i}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  {i > 0 && <span style={{ color: '#585b70' }}>/</span>}
                  <button
                    type="button"
                    style={crumbBtn}
                    disabled={i === breadcrumb.length - 1}
                    onClick={() => navigate(c.uri)}
                  >
                    {c.label}
                  </button>
                </span>
              ))}
              <button type="button" style={navBtn} disabled={!parent} onClick={() => navigate(parent)}>
                ↑ 上一级
              </button>
              <button type="button" style={navBtn} disabled={loading || busy} onClick={() => void loadList(uri)}>
                刷新
              </button>
              <button type="button" style={navBtn} onClick={() => void copyUri(uri)}>
                {copied ? '已复制' : '复制 URI'}
              </button>
            </div>

            <div style={pathDisplay} title={uri}>{uri}</div>

            {writable && (
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
            )}

            {!writable && selected && selected.kind !== 'dir' && (
              <div style={actions}>
                <button type="button" style={secondaryBtn} disabled={busy} onClick={() => void downloadSelected()}>
                  下载
                </button>
              </div>
            )}

            {showNew && writable && (
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
                      onClick={() => void openEntry({ ...entry, kind: isDir ? 'dir' : 'file' })}
                      onDoubleClick={() => void openEntry({ ...entry, kind: isDir ? 'dir' : 'file' })}
                    >
                      <span style={folderIcon}>{isDir ? '▸' : '·'}</span>
                      <span style={rowName}>{entryName(entry.path)}</span>
                      <span style={rowMeta}>{isDir ? '目录' : formatSize(entry.size)}</span>
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
          </>
        )}
      </main>
    </div>
  );
}

const shell: React.CSSProperties = {
  display: 'flex', gap: 0, alignItems: 'stretch', minHeight: 520,
  background: '#1e1e2e', border: '1px solid #313244', borderRadius: 10, overflow: 'hidden',
};
const sideNav: React.CSSProperties = {
  width: 200, flexShrink: 0, borderRight: '1px solid #313244',
  display: 'flex', flexDirection: 'column', gap: 2, padding: '10px 8px',
  background: '#181825', overflowY: 'auto',
};
const sideSection: React.CSSProperties = {
  color: '#6c7086', fontSize: 11, padding: '12px 10px 4px', fontWeight: 600, letterSpacing: 0.3,
};
const sideHint: React.CSSProperties = { color: '#585b70', fontSize: 11, margin: '0 10px 6px', lineHeight: 1.4 };
const sideItem = (active: boolean): React.CSSProperties => ({
  display: 'flex', gap: 8, alignItems: 'flex-start', textAlign: 'left',
  background: active ? '#313244' : 'transparent',
  color: active ? '#89b4fa' : '#cdd6f4',
  border: 'none', borderRadius: 6, padding: '8px 10px', cursor: 'pointer', width: '100%',
});
const sideIcon: React.CSSProperties = { flexShrink: 0, color: '#89b4fa', fontSize: 14, lineHeight: '18px' };
const sideLabel: React.CSSProperties = { fontSize: 13, fontWeight: 600, lineHeight: 1.3 };
const sideSub: React.CSSProperties = { fontSize: 10, color: '#6c7086', marginTop: 2 };
const mainPane: React.CSSProperties = { flex: 1, minWidth: 0, padding: '16px 18px', overflow: 'auto' };
const mainHeader: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 14,
};
const mainTitle: React.CSSProperties = { margin: 0, color: '#cdd6f4', fontSize: 16 };
const mainHint: React.CSSProperties = { margin: '4px 0 0', color: '#a6adc8', fontSize: 12 };
const roBadge: React.CSSProperties = {
  background: '#313244', color: '#fab387', borderRadius: 4, padding: '4px 8px', fontSize: 11, flexShrink: 0,
};
const warn: React.CSSProperties = { color: '#f9e2af', fontSize: 13, margin: '0 0 12px' };
const muted: React.CSSProperties = { color: '#6c7086', fontSize: 13, margin: 12 };
const spaceGrid: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10,
};
const spaceCard: React.CSSProperties = {
  background: '#11111b', border: '1px solid #313244', borderRadius: 8, padding: '14px 12px',
  cursor: 'pointer', textAlign: 'left', color: '#cdd6f4',
};
const spaceName: React.CSSProperties = { fontSize: 14, fontWeight: 600, marginBottom: 6 };
const spaceCode: React.CSSProperties = {
  fontSize: 10, color: '#6c7086', fontFamily: 'ui-monospace, Menlo, monospace',
  wordBreak: 'break-all',
};
const agentJumpRow: React.CSSProperties = { display: 'flex', gap: 8, marginBottom: 12 };
const chipBtn = (active: boolean): React.CSSProperties => ({
  background: active ? '#313244' : 'transparent',
  color: active ? '#89b4fa' : '#a6adc8',
  border: `1px solid ${active ? '#89b4fa66' : '#45475a'}`,
  borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontSize: 12,
});
const crumbRow: React.CSSProperties = {
  display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 8,
};
const crumbBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', color: '#89b4fa', cursor: 'pointer', fontSize: 12, padding: '2px 4px',
};
const navBtn: React.CSSProperties = {
  background: 'transparent', border: '1px solid #45475a', color: '#a6adc8',
  borderRadius: 5, padding: '3px 8px', cursor: 'pointer', fontSize: 11, whiteSpace: 'nowrap', marginLeft: 4,
};
const pathDisplay: React.CSSProperties = {
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11, color: '#6c7086',
  background: '#11111b', border: '1px solid #313244', borderRadius: 5, padding: '5px 8px', marginBottom: 10,
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
  display: 'grid', gridTemplateColumns: 'minmax(200px, 1fr) minmax(200px, 1fr)', gap: 12,
};
const listBox: React.CSSProperties = {
  minHeight: 260, maxHeight: 440, overflowY: 'auto',
  background: '#11111b', border: '1px solid #313244', borderRadius: 6,
};
const previewBox: React.CSSProperties = {
  minHeight: 260, maxHeight: 440, overflowY: 'auto',
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
