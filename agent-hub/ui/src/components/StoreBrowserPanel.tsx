import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, getHubAuthToken } from '../api/client.js';
import type {
  StoreEntry,
  StoreMapping,
  StoreRecentEntry,
  StoreRootsResult,
} from '../api/types.js';
import { useI18n } from '../i18n/index.js';
import type { MessageKey } from '../i18n/en.js';

export interface StoreBrowserPanelProps {
  initialUri?: string | null;
  onUriChange?: (uri: string | null) => void;
}

type SideSelection =
  | { kind: 'local' }
  | { kind: 'peer'; fingerprint: string }
  | { kind: 'agent'; instanceId: string };

type PreviewKind = 'text' | 'image' | 'json' | 'binary' | 'empty';

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

function formatTime(ms: number, t: (key: MessageKey, vars?: Record<string, string | number>) => string): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const now = Date.now();
  const diff = now - ms;
  if (diff < 60_000) return t('store.justNow');
  if (diff < 3600_000) return t('store.minutesAgo', { n: Math.floor(diff / 60_000) });
  if (diff < 86400_000) return t('store.hoursAgo', { n: Math.floor(diff / 3600_000) });
  if (diff < 7 * 86400_000) return t('store.daysAgo', { n: Math.floor(diff / 86400_000) });
  return d.toLocaleString();
}

const SPACE_KEYS: Record<string, MessageKey> = {
  workspaces: 'store.space.workspaces',
  runtime: 'store.space.runtime',
  files: 'store.space.files',
  public: 'store.space.public',
  memory: 'store.space.memory',
  artifacts: 'store.space.artifacts',
  agents: 'store.space.agents',
  sessions: 'store.space.sessions',
  attachments: 'store.space.attachments',
  backups: 'store.space.backups',
};

function spaceLabel(space: string, t: (key: MessageKey) => string): string {
  const key = SPACE_KEYS[space];
  return key ? t(key) : space;
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

function fileIcon(name: string, isDir: boolean): string {
  if (isDir) return '📁';
  const e = extOf(name);
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(e)) return '🖼';
  if (['mp4', 'mov', 'webm', 'mkv'].includes(e)) return '🎬';
  if (['mp3', 'wav', 'm4a', 'flac'].includes(e)) return '🎵';
  if (['pdf'].includes(e)) return '📄';
  if (['zip', 'tar', 'gz', 'tgz', '7z', 'rar'].includes(e)) return '🗜';
  if (['json', 'jsonl'].includes(e)) return '{ }';
  if (['md', 'txt', 'log', 'csv'].includes(e)) return '📝';
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h'].includes(e)) return '💻';
  return '📃';
}

function detectPreviewKind(name: string, bytes: Uint8Array): PreviewKind {
  const e = extOf(name);
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(e)) return 'image';
  if (e === 'json' || e === 'jsonl') return 'json';
  if (['txt', 'md', 'markdown', 'csv', 'log', 'yml', 'yaml', 'toml', 'xml', 'html', 'css', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'sh', 'env', 'svg'].includes(e)) {
    return 'text';
  }
  const sample = bytes.subarray(0, Math.min(bytes.length, 512));
  let odd = 0;
  for (const b of sample) {
    if (b === 0) return 'binary';
    if (b < 7 || (b > 14 && b < 32)) odd += 1;
  }
  return odd / Math.max(sample.length, 1) < 0.1 ? 'text' : 'binary';
}

function mimeForExt(name: string): string {
  const e = extOf(name);
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
  };
  return map[e] ?? 'application/octet-stream';
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

function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    for (let j = 0; j < slice.length; j += 1) {
      binary += String.fromCharCode(slice[j]!);
    }
  }
  return btoa(binary);
}

function isDirEntry(entry: StoreEntry): boolean {
  return entry.kind === 'dir' || (!entry.kind && !entry.sha256 && entry.size === 0);
}

export function StoreBrowserPanel({ initialUri, onUriChange }: StoreBrowserPanelProps) {
  const { t } = useI18n();
  const [roots, setRoots] = useState<StoreRootsResult | null>(null);
  const [side, setSide] = useState<SideSelection>({ kind: 'local' });
  const [uri, setUri] = useState<string | null>(null);
  const [entries, setEntries] = useState<StoreEntry[]>([]);
  const [recent, setRecent] = useState<StoreRecentEntry[]>([]);
  const [parent, setParent] = useState<string | null>(null);
  const [writable, setWritable] = useState(true);
  const [selected, setSelected] = useState<StoreEntry | null>(null);
  const [previewKind, setPreviewKind] = useState<PreviewKind>('empty');
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newContent, setNewContent] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [copied, setCopied] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const initialApplied = useRef(false);
  const previewUrlRef = useRef<string | null>(null);

  const clearPreview = useCallback(() => {
    setSelected(null);
    setPreviewKind('empty');
    setPreviewText(null);
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setPreviewUrl(null);
  }, []);

  const navigate = useCallback((next: string | null) => {
    setUri(next);
    clearPreview();
    onUriChange?.(next);
  }, [onUriChange, clearPreview]);

  const applyUriSelection = useCallback((target: string, rootsData: StoreRootsResult) => {
    const parsed = parseCurrent(target);
    if (!parsed) return;
    if (parsed.device === rootsData.local.deviceId) {
      const agent = rootsData.agents.find((a) =>
        parsed.space === 'agents' && parsed.path.split('/')[0] === a.instanceId,
      );
      if (agent) setSide({ kind: 'agent', instanceId: agent.instanceId });
      else setSide({ kind: 'local' });
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

  const loadRecent = useCallback(async (sel: SideSelection, rootsData: StoreRootsResult) => {
    try {
      setErr(null);
      if (sel.kind === 'local') {
        const data = await api.store.recent({
          device: rootsData.local.deviceId,
          spaces: rootsData.local.spaces,
          limit: 40,
        });
        setRecent(data.entries);
        setWritable(true);
      } else if (sel.kind === 'peer') {
        const peer = rootsData.peers.find((p) => p.fingerprint === sel.fingerprint);
        const data = await api.store.recent({
          device: sel.fingerprint,
          spaces: peer?.spaces,
          limit: 40,
        });
        setRecent(data.entries);
        setWritable(false);
      } else {
        const agent = rootsData.agents.find((a) => a.instanceId === sel.instanceId);
        if (!agent) {
          setRecent([]);
          return;
        }
        const data = await api.store.recent({
          device: agent.deviceId,
          spaces: ['agents'],
          prefix: agent.instanceId,
          limit: 40,
        });
        setRecent(data.entries);
        setWritable(true);
      }
    } catch (e) {
      setRecent([]);
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadList = useCallback(async (target: string | null) => {
    setLoading(true);
    setErr(null);
    clearPreview();
    try {
      if (!target) {
        setEntries([]);
        setParent(null);
        return;
      }
      const data = await api.store.list(target, 1);
      // Folders first, then files by name
      const sorted = [...data.entries].sort((a, b) => {
        const ad = isDirEntry(a) ? 0 : 1;
        const bd = isDirEntry(b) ? 0 : 1;
        if (ad !== bd) return ad - bd;
        return entryName(a.path).localeCompare(entryName(b.path), undefined, { sensitivity: 'base' });
      });
      setEntries(sorted);
      setParent(data.parent);
      setWritable(data.writable !== false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setEntries([]);
      setParent(null);
    } finally {
      setLoading(false);
    }
  }, [clearPreview]);

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
          } else {
            await loadRecent({ kind: 'local' }, data);
          }
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!initialUri || !roots || !initialApplied.current) return;
    applyUriSelection(initialUri, roots);
    setUri(initialUri);
  }, [initialUri, roots, applyUriSelection]);

  useEffect(() => {
    if (uri) {
      void loadList(uri);
      return;
    }
    if (!roots) return;
    setLoading(true);
    void loadRecent(side, roots).finally(() => setLoading(false));
  }, [uri, side, roots, loadList, loadRecent]);

  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

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
    if (side.kind === 'peer') return activePeer?.spaces ?? [];
    if (side.kind === 'agent') return [];
    return roots.local.spaces;
  }, [roots, side, activePeer]);

  const breadcrumb = useMemo(() => {
    if (!uri) return [] as { label: string; uri: string | null }[];
    const parsed = parseCurrent(uri);
    if (!parsed) return [];
    const parts = parsed.path ? parsed.path.split('/').filter(Boolean) : [];
    const crumbs: { label: string; uri: string | null }[] = [
      { label: t('common.home'), uri: null },
      { label: spaceLabel(parsed.space, t), uri: entryUri(parsed.space, parsed.device, '') },
    ];
    let acc = '';
    for (const seg of parts) {
      acc = acc ? `${acc}/${seg}` : seg;
      crumbs.push({ label: seg, uri: entryUri(parsed.space, parsed.device, acc) });
    }
    return crumbs;
  }, [uri, t]);

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
    navigate(null);
  };

  const openSpace = (space: string) => {
    if (!roots) return;
    const device = side.kind === 'peer' ? side.fingerprint : roots.local.deviceId;
    navigate(entryUri(space, device, ''));
  };

  const previewFile = async (fileUri: string, name: string) => {
    setBusy(true);
    setErr(null);
    try {
      const data = await api.store.read(fileUri);
      const bytes = Uint8Array.from(atob(data.contentBase64), (c) => c.charCodeAt(0));
      const kind = detectPreviewKind(name, bytes);
      setPreviewKind(kind);
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = null;
      }
      setPreviewUrl(null);
      if (kind === 'image') {
        const blob = new Blob([bytes], { type: mimeForExt(name) });
        const url = URL.createObjectURL(blob);
        previewUrlRef.current = url;
        setPreviewUrl(url);
        setPreviewText(null);
      } else if (kind === 'json') {
        const raw = new TextDecoder().decode(bytes);
        try {
          setPreviewText(JSON.stringify(JSON.parse(raw), null, 2));
        } catch {
          setPreviewText(raw);
        }
      } else if (kind === 'text') {
        setPreviewText(new TextDecoder().decode(bytes));
      } else {
        setPreviewText(t('store.previewFail', { size: formatSize(data.size) }));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPreviewKind('empty');
      setPreviewText(null);
    } finally {
      setBusy(false);
    }
  };

  const openEntry = async (entry: StoreEntry, mode: 'select' | 'open' = 'open') => {
    if (!uri) return;
    const parsed = parseCurrent(uri);
    if (!parsed) return;
    const nextUri = entryUri(parsed.space, parsed.device, entry.path);
    const dir = isDirEntry(entry);
    if (dir) {
      if (mode === 'open') navigate(nextUri.endsWith('/') ? nextUri : `${nextUri}/`);
      return;
    }
    setSelected(entry);
    if (mode === 'open' || mode === 'select') {
      await previewFile(nextUri, entryName(entry.path));
    }
  };

  const openRecent = async (item: StoreRecentEntry) => {
    // Jump into parent folder and preview
    const parsed = parseCurrent(item.uri);
    if (!parsed) return;
    const parts = parsed.path.split('/').filter(Boolean);
    parts.pop();
    const parentPath = parts.join('/');
    const folderUri = entryUri(parsed.space, parsed.device, parentPath);
    setUri(folderUri);
    onUriChange?.(folderUri);
    clearPreview();
    setLoading(true);
    try {
      const data = await api.store.list(folderUri, 1);
      const sorted = [...data.entries].sort((a, b) => {
        const ad = isDirEntry(a) ? 0 : 1;
        const bd = isDirEntry(b) ? 0 : 1;
        if (ad !== bd) return ad - bd;
        return entryName(a.path).localeCompare(entryName(b.path), undefined, { sensitivity: 'base' });
      });
      setEntries(sorted);
      setParent(data.parent);
      setWritable(data.writable !== false);
      const fileEntry = sorted.find((e) => e.path === parsed.path);
      if (fileEntry) {
        setSelected(fileEntry);
        await previewFile(item.uri, entryName(item.path));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const deleteSelected = async () => {
    if (!selected || !uri || !writable) return;
    const parsed = parseCurrent(uri);
    if (!parsed) return;
    const target = entryUri(parsed.space, parsed.device, selected.path);
    if (!confirm(t('store.deleteConfirm', { target }))) return;
    setBusy(true);
    setErr(null);
    try {
      await api.store.remove(target);
      clearPreview();
      await loadList(uri);
      if (roots) void loadRecent(side, roots);
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
      if (roots) void loadRecent(side, roots);
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
    const maxBytes = 5 * 1024 * 1024;
    if (file.size > maxBytes) {
      setErr(t('store.tooBig', { size: formatSize(file.size) }));
      return;
    }
    const base = parsed.path ? `${parsed.path}/` : '';
    const filePath = `${base}${file.name}`;
    const target = entryUri(parsed.space, parsed.device, filePath);
    setBusy(true);
    setErr(null);
    try {
      const buf = await file.arrayBuffer();
      await api.store.write({ uri: target, contentBase64: bytesToBase64(new Uint8Array(buf)) });
      await loadList(uri);
      if (roots) void loadRecent(side, roots);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const downloadUri = async (fileUri: string, name: string) => {
    setBusy(true);
    try {
      const data = await api.store.read(fileUri);
      const bytes = Uint8Array.from(atob(data.contentBase64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes]);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const downloadSelected = async () => {
    if (!selected || !uri) return;
    const parsed = parseCurrent(uri);
    if (!parsed) return;
    await downloadUri(entryUri(parsed.space, parsed.device, selected.path), entryName(selected.path));
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

  const sideTitle = side.kind === 'local'
    ? t('store.local')
    : side.kind === 'peer'
      ? (activePeer?.deviceName ?? t('store.pairedDevice'))
      : (activeAgent?.label ?? 'Agent');

  const showHome = !uri;
  const showPreviewPane = Boolean(
    selected && !isDirEntry(selected) && (busy || previewKind !== 'empty'),
  );

  return (
    <div style={shell}>
      <aside style={sideNav}>
        <button type="button" style={sideItem(side.kind === 'local')} onClick={selectLocal}>
          <span style={sideIcon}>⌂</span>
          <span>
            <div style={sideLabel}>{t('store.local')}</div>
            <div style={sideSub}>{t('store.localSub', { id: roots?.local.deviceId.slice(0, 8) ?? t('common.ellipsis') })}</div>
          </span>
        </button>

        <div style={sideSection}>{t('store.pairedDevice')}</div>
        {!roots?.peerService.running && (
          <p style={sideHint}>{t('store.peerHint')}</p>
        )}
        {roots?.peers.length === 0 && (
          <p style={sideHint}>{t('store.noPeers')}</p>
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
              <div style={sideSub}>{t('store.peerSub', { id: p.fingerprint.slice(0, 8) })}</div>
            </span>
          </button>
        ))}

        <div style={sideSection}>{t('store.agentSpaces')}</div>
        {roots?.agents.length === 0 && (
          <p style={sideHint}>{t('store.noAgents')}</p>
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
          <p style={warn}>{t('store.tokenWarn', { state: getHubAuthToken() ? t('store.tokenInvalid') : t('store.tokenMissing') })}</p>
        )}
        {err && !/unauthorized|SHEPAW_HUB_TOKEN/i.test(err) && (
          <p style={{ color: '#f38ba8', fontSize: 13, margin: '0 0 12px' }}>{err}</p>
        )}

        <div style={mainHeader}>
          <div>
            <h3 style={mainTitle}>{sideTitle}</h3>
            <p style={mainHint}>
              {showHome
                ? t('store.homeHint')
                : t('store.browseHint')}
            </p>
          </div>
          {!writable && (
            <span style={roBadge}>{t('common.readonly')}</span>
          )}
        </div>

        {/* ── Home: folders first, then recent ───────────────────── */}
        {showHome && (
          <div style={homeScroll}>
            <section style={{ marginBottom: 20, flexShrink: 0 }}>
              <h4 style={sectionTitle}>{t('store.partitions')}</h4>
              {side.kind === 'agent' && activeAgent ? (
                <div style={spaceGrid}>
                  <button type="button" style={spaceCard} onClick={() => navigate(activeAgent.agentUri)}>
                    <div style={spaceIconBig}>📁</div>
                    <div style={spaceName}>{t('store.space.agents')}</div>
                    <code style={spaceCode}>agents/{activeAgent.instanceId}</code>
                  </button>
                  <button type="button" style={spaceCard} onClick={() => navigate(activeAgent.workspaceUri)}>
                    <div style={spaceIconBig}>📁</div>
                    <div style={spaceName}>Workspace</div>
                    <code style={spaceCode}>workspaces/…</code>
                  </button>
                </div>
              ) : (
                <div style={spaceGrid}>
                  {spaces.map((space) => (
                    <button key={space} type="button" style={spaceCard} onClick={() => openSpace(space)}>
                      <div style={spaceIconBig}>📁</div>
                      <div style={spaceName}>{spaceLabel(space, t)}</div>
                      <code style={spaceCode}>{space}</code>
                    </button>
                  ))}
                </div>
              )}
            </section>

            <section style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <h4 style={sectionTitle}>{t('store.recent')}</h4>
              {loading && <p style={muted}>{t('common.loading')}</p>}
              {!loading && recent.length === 0 && (
                <p style={muted}>{t('store.noRecent')}</p>
              )}
              {!loading && recent.length > 0 && (
                <div style={recentList}>
                  {recent.map((item) => (
                    <button
                      key={item.uri}
                      type="button"
                      style={recentRow}
                      onClick={() => void openRecent(item)}
                      title={item.uri}
                    >
                      <span style={fileIconStyle}>{fileIcon(entryName(item.path), false)}</span>
                      <span style={recentMain}>
                        <span style={recentName}>{entryName(item.path)}</span>
                        <span style={recentMeta}>
                          {spaceLabel(item.space, t)} · {item.path}
                        </span>
                      </span>
                      <span style={recentRight}>
                        <span>{formatSize(item.size)}</span>
                        <span>{formatTime(item.mtime, t)}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        {/* ── Folder browser ─────────────────────────────────────── */}
        {uri && (
          <div style={browserPane}>
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
              <button type="button" style={navBtn} disabled={!parent && breadcrumb.length <= 1} onClick={() => navigate(parent ?? null)}>
                {t('picker.up')}
              </button>
              <button type="button" style={navBtn} disabled={loading || busy} onClick={() => void loadList(uri)}>
                {t('common.refresh')}
              </button>
              <button type="button" style={navBtn} onClick={() => void copyUri(uri)}>
                {copied ? t('common.copied') : t('store.copyUri')}
              </button>
            </div>

            <div style={toolbar}>
              {writable && (
                <>
                  <button type="button" style={primaryBtn} disabled={busy} onClick={() => fileInputRef.current?.click()}>
                    {t('common.upload')}
                  </button>
                  <button type="button" style={secondaryBtn} disabled={busy} onClick={() => setShowNew((v) => !v)}>
                    {t('store.newText')}
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
                </>
              )}
              {selected && !isDirEntry(selected) && (
                <>
                  <button type="button" style={secondaryBtn} disabled={busy} onClick={() => void downloadSelected()}>
                    {t('common.download')}
                  </button>
                  {writable && (
                    <button type="button" style={dangerBtn} disabled={busy} onClick={() => void deleteSelected()}>
                      {t('common.delete')}
                    </button>
                  )}
                </>
              )}
            </div>

            {showNew && writable && (
              <div style={newBox}>
                <input
                  style={inp}
                  placeholder={t('store.filename')}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
                <textarea
                  style={{ ...inp, minHeight: 90, fontFamily: 'ui-monospace, Menlo, monospace' }}
                  placeholder={t('store.content')}
                  value={newContent}
                  onChange={(e) => setNewContent(e.target.value)}
                />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" style={primaryBtn} disabled={busy || !newName.trim()} onClick={() => void createFile()}>
                    {t('common.save')}
                  </button>
                  <button type="button" style={secondaryBtn} onClick={() => setShowNew(false)}>{t('common.cancel')}</button>
                </div>
              </div>
            )}

            <div style={showPreviewPane ? browserSplit : browserFull}>
              <div style={listBox}>
                <div style={listHeader}>
                  <span style={{ ...colName, paddingLeft: 28 }}>{t('store.colName')}</span>
                  <span style={colSize}>{t('store.colSize')}</span>
                  <span style={colTime}>{t('store.colMtime')}</span>
                </div>
                {loading && <p style={muted}>{t('common.loading')}</p>}
                {!loading && entries.length === 0 && <p style={muted}>{t('store.emptyFolder')}</p>}
                {!loading && entries.map((entry) => {
                  const dir = isDirEntry(entry);
                  const active = selected?.path === entry.path;
                  const name = entryName(entry.path);
                  return (
                    <div
                      key={entry.path}
                      role="option"
                      aria-selected={active}
                      style={{ ...fileRow, ...(active ? fileRowActive : {}) }}
                      onClick={() => void openEntry(entry, 'select')}
                      onDoubleClick={() => void openEntry(entry, 'open')}
                    >
                      <span style={fileIconStyle}>{fileIcon(name, dir)}</span>
                      <span style={colName}>{name}</span>
                      <span style={colSize}>{dir ? '—' : formatSize(entry.size)}</span>
                      <span style={colTime}>{formatTime(entry.mtime, t)}</span>
                    </div>
                  );
                })}
              </div>

              {showPreviewPane && (
                <div style={previewBox}>
                  <div style={previewHeaderRow}>
                    <span style={previewHeader}>{t('store.preview')}{selected ? ` · ${entryName(selected.path)}` : ''}</span>
                    <button type="button" style={previewClose} onClick={clearPreview} aria-label={t('common.close')}>
                      ✕
                    </button>
                  </div>
                  {busy && <p style={muted}>{t('store.reading')}</p>}
                  {!busy && previewKind === 'image' && previewUrl && (
                    <img src={previewUrl} alt="preview" style={previewImg} />
                  )}
                  {!busy && (previewKind === 'text' || previewKind === 'json') && previewText !== null && (
                    <pre style={previewPre}>{previewText}</pre>
                  )}
                  {!busy && previewKind === 'binary' && previewText !== null && (
                    <div>
                      <p style={muted}>{previewText}</p>
                      {selected && uri && (
                        <button
                          type="button"
                          style={{ ...secondaryBtn, marginTop: 8 }}
                          onClick={() => void downloadSelected()}
                        >
                          {t('store.downloadFile')}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

const shell: React.CSSProperties = {
  display: 'flex', gap: 0, alignItems: 'stretch',
  height: 'calc(100vh - 140px)', minHeight: 420,
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
const mainPane: React.CSSProperties = {
  flex: 1, minWidth: 0, minHeight: 0, padding: '16px 18px',
  display: 'flex', flexDirection: 'column', overflow: 'hidden',
};
const mainHeader: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 14, flexShrink: 0,
};
const mainTitle: React.CSSProperties = { margin: 0, color: '#cdd6f4', fontSize: 16 };
const mainHint: React.CSSProperties = { margin: '4px 0 0', color: '#a6adc8', fontSize: 12 };
const homeScroll: React.CSSProperties = {
  flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden',
};
const browserPane: React.CSSProperties = {
  flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden',
};
const sectionTitle: React.CSSProperties = { margin: '0 0 10px', color: '#cdd6f4', fontSize: 13, fontWeight: 600 };
const roBadge: React.CSSProperties = {
  background: '#313244', color: '#fab387', borderRadius: 4, padding: '4px 8px', fontSize: 11, flexShrink: 0,
};
const warn: React.CSSProperties = { color: '#f9e2af', fontSize: 13, margin: '0 0 12px' };
const muted: React.CSSProperties = { color: '#6c7086', fontSize: 13, margin: 12 };
const spaceGrid: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 10,
};
const spaceCard: React.CSSProperties = {
  background: '#11111b', border: '1px solid #313244', borderRadius: 8, padding: '16px 12px',
  cursor: 'pointer', textAlign: 'center', color: '#cdd6f4',
};
const spaceIconBig: React.CSSProperties = { fontSize: 28, marginBottom: 8, lineHeight: 1 };
const spaceName: React.CSSProperties = { fontSize: 14, fontWeight: 600, marginBottom: 4 };
const spaceCode: React.CSSProperties = {
  fontSize: 10, color: '#6c7086', fontFamily: 'ui-monospace, Menlo, monospace',
};
const recentList: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 2,
  background: '#11111b', border: '1px solid #313244', borderRadius: 8,
  flex: 1, minHeight: 160, overflowY: 'auto',
};
const recentRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
  background: 'transparent', border: 'none', borderBottom: '1px solid #1e1e2e',
  cursor: 'pointer', textAlign: 'left', color: '#cdd6f4', width: '100%',
};
const recentMain: React.CSSProperties = { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 };
const recentName: React.CSSProperties = {
  fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const recentMeta: React.CSSProperties = {
  fontSize: 11, color: '#6c7086', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  fontFamily: 'ui-monospace, Menlo, monospace',
};
const recentRight: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2,
  fontSize: 11, color: '#6c7086', flexShrink: 0,
};
const fileIconStyle: React.CSSProperties = { flexShrink: 0, fontSize: 16, width: 22, textAlign: 'center' };
const crumbRow: React.CSSProperties = {
  display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 10, flexShrink: 0,
};
const crumbBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', color: '#89b4fa', cursor: 'pointer', fontSize: 12, padding: '2px 4px',
};
const navBtn: React.CSSProperties = {
  background: 'transparent', border: '1px solid #45475a', color: '#a6adc8',
  borderRadius: 5, padding: '3px 8px', cursor: 'pointer', fontSize: 11, whiteSpace: 'nowrap', marginLeft: 4,
};
const toolbar: React.CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, flexShrink: 0 };
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
  display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12, flexShrink: 0,
  padding: 12, background: '#181825', border: '1px solid #313244', borderRadius: 6,
};
const inp: React.CSSProperties = {
  background: '#11111b', border: '1px solid #45475a', borderRadius: 5,
  color: '#cdd6f4', padding: '6px 10px', fontSize: 13, outline: 'none', width: '100%', boxSizing: 'border-box',
};
const browserSplit: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'minmax(280px, 1.2fr) minmax(200px, 1fr)', gap: 12,
  flex: 1, minHeight: 0,
};
const browserFull: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0,
};
const listBox: React.CSSProperties = {
  flex: 1, minHeight: 200, overflowY: 'auto',
  background: '#11111b', border: '1px solid #313244', borderRadius: 6,
};
const listHeader: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
  borderBottom: '1px solid #313244', color: '#6c7086', fontSize: 11, fontWeight: 600,
  position: 'sticky', top: 0, background: '#11111b', zIndex: 1,
};
const fileRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px',
  cursor: 'pointer', borderBottom: '1px solid #1e1e2e', color: '#cdd6f4', fontSize: 13,
};
const fileRowActive: React.CSSProperties = { background: '#313244', outline: '1px solid #89b4fa66' };
const colName: React.CSSProperties = {
  flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12,
};
const colSize: React.CSSProperties = { width: 72, flexShrink: 0, textAlign: 'right', color: '#6c7086', fontSize: 11 };
const colTime: React.CSSProperties = { width: 88, flexShrink: 0, textAlign: 'right', color: '#6c7086', fontSize: 11 };
const previewBox: React.CSSProperties = {
  minHeight: 0, overflowY: 'auto',
  background: '#11111b', border: '1px solid #313244', borderRadius: 6, padding: 12,
};
const previewHeaderRow: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8,
};
const previewHeader: React.CSSProperties = {
  color: '#6c7086', fontSize: 11, fontWeight: 600,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
};
const previewClose: React.CSSProperties = {
  background: 'transparent', border: 'none', color: '#a6adc8', cursor: 'pointer',
  fontSize: 14, padding: '0 4px', flexShrink: 0, lineHeight: 1,
};
const previewPre: React.CSSProperties = {
  margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
  color: '#cdd6f4', fontSize: 12, fontFamily: 'ui-monospace, Menlo, monospace',
};
const previewImg: React.CSSProperties = {
  maxWidth: '100%', maxHeight: 'calc(100vh - 280px)', objectFit: 'contain', borderRadius: 4,
};
