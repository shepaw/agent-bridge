import { useCallback, useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { api } from '../api/client.js';
import type { Instance, Peer, EnrollToken } from '../api/types.js';
import { LogViewer } from './LogViewer.js';
import { EnrollModal } from './EnrollModal.js';
import { SessionResumeModal } from './SessionResumeModal.js';
import { SessionsPanel } from './SessionsPanel.js';
import { AttachmentsPanel } from './AttachmentsPanel.js';
import { InstanceApprovalSection } from './InstanceApprovalSection.js';
import { DirectoryPickerModal } from './DirectoryPickerModal.js';
import { maskSecret } from '../utils/maskSecret.js';
import { isSensitiveEnvVarKey } from '../utils/envVarSensitivity.js';
import {
  availabilityColor,
  busyColor,
  busyLabel,
  formatRuntimeSummary,
} from '../utils/runtimeStatus.js';
import type { InstanceDetailTab } from '../utils/instanceRoute.js';

interface InstanceDetailProps {
  instanceId: string;
  activeTab: InstanceDetailTab;
  onTabChange: (tab: InstanceDetailTab) => void;
  initialSessionId?: string | null;
  onSessionChange?: (sessionId: string | null) => void;
  onBack: () => void;
  onReload: () => void;
  /** Jump to global store browser at a URI. */
  onOpenStore?: (uri: string) => void;
}

const NAV_ITEMS: { id: InstanceDetailTab; label: string }[] = [
  { id: 'overview', label: '概览' },
  { id: 'sessions', label: '会话' },
  { id: 'logs', label: '日志' },
  { id: 'devices', label: '设备' },
  { id: 'attachments', label: '附件' },
  { id: 'config', label: '配置' },
];

export function InstanceDetail({
  instanceId,
  activeTab,
  onTabChange,
  initialSessionId = null,
  onSessionChange,
  onBack,
  onReload,
  onOpenStore,
}: InstanceDetailProps) {
  const [instance, setInstance] = useState<Instance | null>(null);
  const [peers, setPeers] = useState<Peer[]>([]);
  // key -> masked display value, populated from GET /envvars
  const [envMasked, setEnvMasked] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showEnroll, setShowEnroll] = useState(false);
  const [showResume, setShowResume] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(initialSessionId ?? null);
  // Inline QR code section
  const [showQr, setShowQr] = useState(false);
  const [qrToken, setQrToken] = useState<EnrollToken | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
  const [qrErr, setQrErr] = useState<string | null>(null);
  const [qrSecondsLeft, setQrSecondsLeft] = useState(0);
  const qrTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // envvars state: key -> pending input value (undefined = not editing)
  const [envEditing, setEnvEditing] = useState<Record<string, string>>({});
  const [envBusy, setEnvBusy] = useState<Record<string, boolean>>({});
  const [envErr, setEnvErr] = useState<string | null>(null);
  const [envDrafts, setEnvDrafts] = useState<{ key: string; value: string }[]>([{ key: '', value: '' }]);
  const [envAddBusy, setEnvAddBusy] = useState(false);
  const [showAddPeer, setShowAddPeer] = useState(false);
  const [addPeerPubkey, setAddPeerPubkey] = useState('');
  const [addPeerLabel, setAddPeerLabel] = useState('');
  const [addPeerErr, setAddPeerErr] = useState<string | null>(null);
  const [addPeerBusy, setAddPeerBusy] = useState(false);
  // Edit state
  const [showEdit, setShowEdit] = useState(false);
  const [editLabel, setEditLabel] = useState('');
  const [editCwd, setEditCwd] = useState('');
  const [editHost, setEditHost] = useState('127.0.0.1');
  const [editBaseUrl, setEditBaseUrl] = useState('');
  const [editExtraArgs, setEditExtraArgs] = useState('');
  const [editTunnelServer, setEditTunnelServer] = useState('');
  const [editTunnelChannelId, setEditTunnelChannelId] = useState('');
  const [editTunnelSecret, setEditTunnelSecret] = useState('');
  const [editClearTunnel, setEditClearTunnel] = useState(false);
  const [showTunnelAdvanced, setShowTunnelAdvanced] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [showDirPicker, setShowDirPicker] = useState(false);

  const load = async () => {
    try {
      const p = await api.instances.get(instanceId);
      const ps = await api.peers.list(instanceId);
      setInstance(p);
      setPeers(ps);

      // Always load env vars so the config tab can add/edit even when empty.
      const envvars = await api.envvars.list(instanceId).catch(() => [] as { key: string; value: string }[]);
      const masked: Record<string, string> = {};
      for (const { key, value } of envvars) masked[key] = value;
      setEnvMasked(masked);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [instanceId]);

  useEffect(() => {
    setSelectedSessionId(initialSessionId ?? null);
    if (initialSessionId) onTabChange('sessions');
  }, [initialSessionId, instanceId]);

  const handleSessionSelect = useCallback((sessionId: string | null) => {
    setSelectedSessionId(sessionId);
    onSessionChange?.(sessionId);
    if (sessionId) onTabChange('sessions');
  }, [onSessionChange, onTabChange]);

  const openManageMappings = useCallback(() => {
    setShowResume(true);
  }, []);

  useEffect(() => {
    const id = setInterval(() => { void load(); }, 3000);
    return () => clearInterval(id);
  }, [instanceId]);

  // QR expiry countdown
  useEffect(() => {
    if (!qrToken) { setQrSecondsLeft(0); return; }
    const update = () => {
      const diff = Math.max(0, Math.floor((new Date(qrToken.expiresAt).getTime() - Date.now()) / 1000));
      setQrSecondsLeft(diff);
      if (diff === 0) {
        setQrToken(null);
        if (qrTimerRef.current) clearInterval(qrTimerRef.current);
      }
    };
    update();
    qrTimerRef.current = setInterval(update, 1000);
    return () => { if (qrTimerRef.current) clearInterval(qrTimerRef.current); };
  }, [qrToken]);

  const mintQr = async () => {
    setQrLoading(true);
    setQrErr(null);
    try {
      const t = await api.enroll.mint(instanceId, {
        ttlMinutes: 10,
        baseUrl: instance?.baseUrl || undefined,
      });
      setQrToken(t);
    } catch (e) {
      setQrErr(e instanceof Error ? e.message : String(e));
    } finally {
      setQrLoading(false);
    }
  };

  const openQr = () => {
    onTabChange('devices');
    setShowQr(true);
    if (!qrToken) void mintQr();
  };

  const toggle = async () => {
    if (!instance) return;
    setBusy(true);
    setErr(null);
    try {
      if (instance.status.running) {
        await api.instances.stop(instance.id);
      } else {
        await api.instances.start(instance.id);
      }
      await load();
      onReload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const addPeer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addPeerPubkey.trim()) return;
    setAddPeerBusy(true);
    setAddPeerErr(null);
    try {
      await api.peers.add(instanceId, addPeerPubkey.trim(), addPeerLabel.trim() || undefined);
      setAddPeerPubkey('');
      setAddPeerLabel('');
      setShowAddPeer(false);
      await load();
    } catch (e) {
      setAddPeerErr(e instanceof Error ? e.message : String(e));
    } finally {
      setAddPeerBusy(false);
    }
  };

  // Sentinels for "value not changed" — used for tunnel secret and env var fields.
  const TUNNEL_SECRET_UNCHANGED = '\x00unchanged';
  const ENV_UNCHANGED = '\x00unchanged';

  const saveEnvVar = async (key: string) => {
    const value = envEditing[key];
    if (value === undefined) return;
    // Sentinel means user never typed a new value — treat as cancel.
    if (value === ENV_UNCHANGED) {
      setEnvEditing((e) => { const n = { ...e }; delete n[key]; return n; });
      return;
    }
    setEnvBusy((b) => ({ ...b, [key]: true }));
    setEnvErr(null);
    try {
      await api.envvars.set(instanceId, key, value);
      setEnvEditing((e) => { const n = { ...e }; delete n[key]; return n; });
      await load();
    } catch (e) {
      setEnvErr(e instanceof Error ? e.message : String(e));
    } finally {
      setEnvBusy((b) => { const n = { ...b }; delete n[key]; return n; });
    }
  };

  const deleteEnvVar = async (key: string) => {
    setEnvBusy((b) => ({ ...b, [key]: true }));
    setEnvErr(null);
    try {
      await api.envvars.remove(instanceId, key);
      await load();
    } catch (e) {
      setEnvErr(e instanceof Error ? e.message : String(e));
    } finally {
      setEnvBusy((b) => { const n = { ...b }; delete n[key]; return n; });
    }
  };

  const saveEnvDrafts = async () => {
    const rows = envDrafts
      .map((r) => ({ key: r.key.trim(), value: r.value }))
      .filter((r) => r.key.length > 0);
    if (rows.length === 0) {
      setEnvErr('请至少填写一个变量名。');
      return;
    }
    const keys = rows.map((r) => r.key);
    if (new Set(keys).size !== keys.length) {
      setEnvErr('草稿中存在重复的变量名。');
      return;
    }
    setEnvAddBusy(true);
    setEnvErr(null);
    try {
      for (const row of rows) {
        await api.envvars.set(instanceId, row.key, row.value);
      }
      setEnvDrafts([{ key: '', value: '' }]);
      await load();
    } catch (e) {
      setEnvErr(e instanceof Error ? e.message : String(e));
    } finally {
      setEnvAddBusy(false);
    }
  };

  const openEdit = (p: typeof instance) => {
    if (!p) return;
    onTabChange('config');
    setEditLabel(p.label);
    setEditCwd(p.cwd);
    setEditHost(p.host);
    setEditBaseUrl(p.baseUrl);
    setEditExtraArgs(p.extraArgs.join(' '));
    setEditTunnelServer(p.tunnel?.serverUrl ?? '');
    setEditTunnelChannelId(p.tunnel?.channelId ?? '');
    // Pre-fill sentinel so existing secret is kept when left untouched.
    setEditTunnelSecret(p.tunnel ? TUNNEL_SECRET_UNCHANGED : '');
    setEditClearTunnel(false);
    // Auto-expand the advanced tunnel section only when the instance already
    // has a per-instance tunnel, so existing config stays visible/editable.
    setShowTunnelAdvanced(!!p.tunnel);
    setEditErr(null);
    setShowEdit(true);
  };

  const submitEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    setEditBusy(true);
    setEditErr(null);
    try {
      const secretUnchanged = editTunnelSecret === TUNNEL_SECRET_UNCHANGED;
      const effectiveSecret = secretUnchanged ? '' : editTunnelSecret;
      // Server/channel pre-filled from existing tunnel — only require secret when
      // the user explicitly typed a new one, or when there was no tunnel before.
      const hasTunnelFields = editTunnelServer && editTunnelChannelId;
      const isNewTunnel = hasTunnelFields && !instance?.tunnel; // no prior tunnel
      if (hasTunnelFields && isNewTunnel && !effectiveSecret) {
        setEditErr('Secret is required when adding a new tunnel.');
        setEditBusy(false);
        return;
      }
      if ((editTunnelServer || editTunnelChannelId) && !(editTunnelServer && editTunnelChannelId)) {
        setEditErr('Both Server URL and Channel ID are required together.');
        setEditBusy(false);
        return;
      }
      // Build tunnel patch:
      // - clearTunnel: remove existing tunnel
      // - new secret typed: update full tunnel (server + channel + new secret)
      // - secret unchanged: update server/channel only (backend keeps existing secret when omitted)
      let tunnelPatch: Record<string, unknown> = {};
      if (editClearTunnel) {
        tunnelPatch = { clearTunnel: true };
      } else if (hasTunnelFields) {
        if (effectiveSecret) {
          // New secret provided — send full tunnel object
          tunnelPatch = { tunnel: { serverUrl: editTunnelServer, channelId: editTunnelChannelId, secret: effectiveSecret } };
        } else if (secretUnchanged) {
          // Secret unchanged — send server/channel; backend will merge with existing secret
          tunnelPatch = { tunnel: { serverUrl: editTunnelServer, channelId: editTunnelChannelId, secret: '' } };
        }
      }
      await api.instances.update(instanceId, {
        label: editLabel || undefined,
        cwd: editCwd || undefined,
        host: editHost || undefined,
        baseUrl: editBaseUrl || undefined,
        extraArgs: editExtraArgs.trim() ? editExtraArgs.trim().split(/\s+/) : [],
        ...tunnelPatch,
      });
      setShowEdit(false);
      await load();
      onReload();
    } catch (e) {
      setEditErr(e instanceof Error ? e.message : String(e));
    } finally {
      setEditBusy(false);
    }
  };

  const removePeer = async (fp: string) => {
    try {
      await api.peers.remove(instanceId, fp);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const removeInstance = async () => {
    if (!confirm(`Remove instance "${instanceId}"?`)) return;
    try {
      await api.instances.remove(instanceId);
      onReload();
      onBack();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  if (loading) return <p style={{ color: '#a6adc8' }}>Loading...</p>;
  if (!instance) return <p style={{ color: '#f38ba8' }}>{err ?? 'Not found'}</p>;

  return (
    <div>
      {/* Header */}
      <div style={header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <button style={backBtn} onClick={onBack}>← 返回</button>
          <span style={dot(instance.status)} />
          <h2 style={{ margin: 0, color: '#cdd6f4' }}>{instance.label}</h2>
          {instance.status.busyLevel !== null && instance.status.availability === 'online' && (
            <code style={{ ...badge, background: busyColor(instance.status), color: '#1e1e2e' }}>
              {busyLabel(instance.status)}
            </code>
          )}
          <code style={badge}>{instance.id}</code>
          <code style={{ ...badge, background: '#313244' }}>{instance.engine}</code>
        </div>
        <button
          style={actionBtn(instance.status.running ? '#c0392b' : '#27ae60')}
          disabled={busy}
          onClick={() => void toggle()}
        >
          {busy ? '...' : instance.status.running ? '停止' : '启动'}
        </button>
      </div>

      {err && <p style={{ color: '#f38ba8', margin: '8px 0' }}>{err}</p>}

      <div style={pageLayout}>
        <nav style={sidebar}>
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              style={navBtn(activeTab === item.id)}
              onClick={() => onTabChange(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <main style={contentPanel}>
          {activeTab === 'overview' && (
            <section>
              <h3 style={panelTitle}>运行概览</h3>
              <p style={panelHint}>实例状态、绑定地址与运行时指标。</p>
              <div style={infoGrid}>
                <InfoItem label="Bind" value={`${instance.host}:${instance.port}`} />
                <InfoItem label="CWD" value={instance.cwd} />
                {instance.baseUrl && <InfoItem label="Base URL" value={instance.baseUrl} />}
                <InfoItem label="Runtime" value={formatRuntimeSummary(instance.status)} />
                {instance.status.activeTasks !== null && (
                  <InfoItem label="Active tasks" value={String(instance.status.activeTasks)} />
                )}
                {instance.status.connectedClients !== null && (
                  <InfoItem label="Connected clients" value={String(instance.status.connectedClients)} />
                )}
                {instance.status.acpSessionCount !== null && (
                  <InfoItem label="ACP sessions" value={String(instance.status.acpSessionCount)} />
                )}
                {instance.status.uptimeMs !== null && instance.status.uptimeMs > 0 && (
                  <InfoItem label="Uptime" value={formatUptime(instance.status.uptimeMs)} />
                )}
                {instance.status.probeError && (
                  <InfoItem label="Probe error" value={instance.status.probeError} />
                )}
                <InfoItem label="Last probe" value={new Date(instance.status.probedAt).toLocaleTimeString()} />
                {instance.status.startedAt && (
                  <InfoItem label="Started" value={new Date(instance.status.startedAt).toLocaleString()} />
                )}
                {instance.status.stoppedAt && (
                  <InfoItem label="Stopped" value={new Date(instance.status.stoppedAt).toLocaleString()} />
                )}
                <InfoItem label="Created" value={new Date(instance.createdAt).toLocaleString()} />
              </div>

              {instance.store && (
                <div style={{ marginTop: 20 }}>
                  <h3 style={panelTitle}>储物袋</h3>
                  <p style={panelHint}>
                    本实例自动映射的 Working Directory 与私有 agents 目录。可在「储物袋」中浏览与管理。
                  </p>
                  <div style={storeBox}>
                    <div style={storeRow}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={storeLabel}>Workspace</div>
                        <code style={storeUri} title={instance.store.workspaceUri}>
                          {instance.store.workspaceUri}
                        </code>
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                        <button
                          type="button"
                          style={storeBtn}
                          onClick={() => void navigator.clipboard.writeText(instance.store!.workspaceUri)}
                        >
                          复制
                        </button>
                        {onOpenStore && (
                          <button
                            type="button"
                            style={storeBtn}
                            onClick={() => onOpenStore(instance.store!.workspaceUri)}
                          >
                            打开
                          </button>
                        )}
                      </div>
                    </div>
                    <div style={storeRow}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={storeLabel}>Agent 私有</div>
                        <code style={storeUri} title={instance.store.agentUri}>
                          {instance.store.agentUri}
                        </code>
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                        <button
                          type="button"
                          style={storeBtn}
                          onClick={() => void navigator.clipboard.writeText(instance.store!.agentUri)}
                        >
                          复制
                        </button>
                        {onOpenStore && (
                          <button
                            type="button"
                            style={storeBtn}
                            onClick={() => onOpenStore(instance.store!.agentUri)}
                          >
                            打开
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </section>
          )}

          {activeTab === 'sessions' && (
            <section>
              <div style={panelHeaderRow}>
                <div>
                  <h3 style={{ ...panelTitle, margin: 0 }}>会话</h3>
                  <p style={{ ...panelHint, margin: '4px 0 0' }}>查看与管理 ACP 会话及对话记录。</p>
                </div>
                <button style={actionBtn('#94e2d5')} onClick={() => setShowResume(true)}>
                  恢复会话
                </button>
              </div>
              <SessionsPanel
                instanceId={instanceId}
                status={instance.status}
                selectedSessionId={selectedSessionId}
                onSelectSession={handleSessionSelect}
                onManageMappings={openManageMappings}
              />
            </section>
          )}

          {activeTab === 'logs' && (
            <section>
              <h3 style={panelTitle}>日志</h3>
              <p style={panelHint}>实例进程实时输出。</p>
              <LogViewer instanceId={instanceId} />
            </section>
          )}

          {activeTab === 'devices' && (
            <section>
              <div style={panelHeaderRow}>
                <div>
                  <h3 style={{ ...panelTitle, margin: 0 }}>设备与配对</h3>
                  <p style={{ ...panelHint, margin: '4px 0 0' }}>扫码连接、配对设备与管理已授权终端。</p>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button style={actionBtn('#89dceb')} onClick={openQr}>
                    扫码连接
                  </button>
                  <button style={actionBtn('#8e44ad')} onClick={() => setShowEnroll(true)}>
                    配对设备
                  </button>
                </div>
              </div>

              {showQr && (
                <div style={qrSection}>
                  <div style={qrSectionHeader}>
                    <span style={{ color: '#cdd6f4', fontWeight: 600, fontSize: 14 }}>连接二维码</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {qrToken && qrSecondsLeft > 0 && (
                        <span style={{ color: qrSecondsLeft <= 60 ? '#f38ba8' : '#a6adc8', fontSize: 12 }}>
                          {Math.floor(qrSecondsLeft / 60)}:{String(qrSecondsLeft % 60).padStart(2, '0')} 后过期
                        </span>
                      )}
                      <button style={qrRefreshBtn} disabled={qrLoading} onClick={() => void mintQr()}>
                        {qrLoading ? '生成中...' : '↻ 刷新'}
                      </button>
                      <button
                        style={qrCloseBtn}
                        onClick={() => { setShowQr(false); setQrToken(null); setQrErr(null); }}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                  <div style={qrBody}>
                    {qrErr && <p style={{ color: '#f38ba8', margin: 0, fontSize: 13 }}>{qrErr}</p>}
                    {qrLoading && <p style={{ color: '#a6adc8', margin: 0 }}>正在生成二维码...</p>}
                    {!qrLoading && qrToken?.qrPayload && (
                      <div style={qrContentWrap}>
                        <div style={qrCodeWrap}>
                          <QRCodeSVG
                            value={qrToken.qrPayload}
                            size={200}
                            bgColor="#1e1e2e"
                            fgColor="#cdd6f4"
                            level="M"
                          />
                        </div>
                        <div style={qrInfoBlock}>
                          <p style={qrInfoRow}>
                            <span style={qrInfoLabel}>配对码</span>
                            <code style={qrCodeBox}>{qrToken.display ?? qrToken.code}</code>
                          </p>
                          {qrToken.pairUrl && (
                            <p style={qrInfoRow}>
                              <span style={qrInfoLabel}>配对地址</span>
                              <code style={{ ...qrCodeBox, fontSize: 11, wordBreak: 'break-all' }}>{qrToken.pairUrl}</code>
                            </p>
                          )}
                          <p style={{ color: '#6c7086', fontSize: 12, marginTop: 12, lineHeight: 1.5 }}>
                            使用 Shepaw 移动端扫描二维码，或手动输入配对码和地址。
                            二维码为一次性使用，首次握手后自动失效。
                          </p>
                        </div>
                      </div>
                    )}
                    {!qrLoading && !qrToken && !qrErr && (
                      <p style={{ color: '#a6adc8', margin: 0, fontSize: 13 }}>点击「刷新」生成新的二维码。</p>
                    )}
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <h4 style={{ ...sectionTitle, margin: 0, border: 'none', padding: 0 }}>
                  已授权设备 ({peers.length})
                </h4>
                <button
                  style={addPeerBtn}
                  onClick={() => { setShowAddPeer((v) => !v); setAddPeerErr(null); }}
                >
                  {showAddPeer ? '✕ 取消' : '+ 添加设备'}
                </button>
              </div>

              {showAddPeer && (
                <form onSubmit={(e) => void addPeer(e)} style={addPeerForm}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <label style={{ color: '#a6adc8', fontSize: 12 }}>Public Key <span style={{ color: '#f38ba8' }}>*</span></label>
                    <input
                      style={addPeerInput}
                      value={addPeerPubkey}
                      onChange={(e) => setAddPeerPubkey(e.target.value)}
                      placeholder="Base64 X25519 public key"
                      required
                      autoFocus
                    />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <label style={{ color: '#a6adc8', fontSize: 12 }}>Label</label>
                    <input
                      style={addPeerInput}
                      value={addPeerLabel}
                      onChange={(e) => setAddPeerLabel(e.target.value)}
                      placeholder="My device (optional)"
                    />
                  </div>
                  {addPeerErr && <p style={{ color: '#f38ba8', margin: 0, fontSize: 13 }}>{addPeerErr}</p>}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button type="submit" style={addPeerSubmitBtn} disabled={addPeerBusy}>
                      {addPeerBusy ? 'Adding...' : 'Add'}
                    </button>
                    <button
                      type="button"
                      style={addPeerCancelBtn}
                      onClick={() => { setShowAddPeer(false); setAddPeerErr(null); }}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}

              {peers.length === 0 ? (
                <p style={{ color: '#a6adc8', fontSize: 14 }}>
                  暂无已授权设备。使用「配对设备」或「添加设备」进行配对。
                </p>
              ) : (
                <div style={peerTable}>
                  <div style={peerRow}>
                    <span style={th}>FINGERPRINT</span>
                    <span style={th}>LABEL</span>
                    <span style={th}>ADDED</span>
                    <span style={th} />
                  </div>
                  {peers.map((peer) => (
                    <div key={peer.fingerprint} style={peerRow}>
                      <code style={{ fontSize: 12, color: '#cdd6f4' }}>{peer.fingerprint}</code>
                      <span style={{ fontSize: 13 }}>{peer.label || '—'}</span>
                      <span style={{ fontSize: 12, color: '#a6adc8' }}>{new Date(peer.addedAt).toLocaleDateString()}</span>
                      <button
                        style={removeBtn}
                        onClick={() => void removePeer(peer.fingerprint)}
                      >
                        Revoke
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {activeTab === 'attachments' && (
            <section>
              <div style={panelHeaderRow}>
                <div>
                  <h3 style={{ ...panelTitle, margin: 0 }}>附件</h3>
                  <p style={{ ...panelHint, margin: '4px 0 0' }}>
                    管理本实例 peer-attachments 目录中手机端推送的文件。
                  </p>
                </div>
              </div>
              <AttachmentsPanel instanceId={instanceId} />
            </section>
          )}

          {activeTab === 'config' && (
            <section>
              <div style={panelHeaderRow}>
                <div>
                  <h3 style={{ ...panelTitle, margin: 0 }}>配置</h3>
                  <p style={{ ...panelHint, margin: '4px 0 0' }}>编辑实例参数、审核策略与高级选项。</p>
                </div>
                {!showEdit && (
                  <button style={actionBtn('#f9e2af')} onClick={() => openEdit(instance)}>
                    编辑
                  </button>
                )}
              </div>

              {showEdit && (
                <form onSubmit={(e) => void submitEdit(e)} style={editForm}>
                  <div style={editGrid}>
                    <div style={editField}>
                      <label style={editLbl}>Label</label>
                      <input style={editInp} value={editLabel} onChange={(e) => setEditLabel(e.target.value)} placeholder={instanceId} />
                    </div>
                    <div style={editField}>
                      <label style={editLbl}>Working Directory <span style={{ color: '#f38ba8' }}>*</span></label>
                      <div style={cwdRow}>
                        <input
                          style={{ ...editInp, flex: 1, minWidth: 0 }}
                          value={editCwd}
                          onChange={(e) => setEditCwd(e.target.value)}
                          placeholder="/path/to/instance"
                          required
                        />
                        <button
                          type="button"
                          style={browseBtn}
                          onClick={() => setShowDirPicker(true)}
                        >
                          浏览…
                        </button>
                      </div>
                    </div>
                    <div style={editField}>
                      <label style={editLbl}>Bind Host</label>
                      <select style={editInp} value={editHost} onChange={(e) => setEditHost(e.target.value)}>
                        <option value="127.0.0.1">127.0.0.1 (loopback only)</option>
                        <option value="0.0.0.0">0.0.0.0 (all interfaces)</option>
                      </select>
                    </div>
                    <div style={editField}>
                      <label style={editLbl}>Base URL</label>
                      <input style={editInp} value={editBaseUrl} onChange={(e) => setEditBaseUrl(e.target.value)} placeholder="https://... (optional)" />
                    </div>
                    <div style={{ ...editField, gridColumn: '1 / -1' }}>
                      <label style={editLbl}>Extra Args <span style={{ color: '#6c7086', fontSize: 11 }}>(space-separated)</span></label>
                      <input style={editInp} value={editExtraArgs} onChange={(e) => setEditExtraArgs(e.target.value)} placeholder="--model claude-opus-4-7 --max-turns 20" />
                    </div>
                  </div>

                  <div style={editTunnelSection}>
                    <button
                      type="button"
                      style={tunnelAdvancedToggle}
                      onClick={() => setShowTunnelAdvanced((v) => !v)}
                    >
                      {showTunnelAdvanced ? '▼' : '▶'} 高级:单独的外网 channel (per-instance tunnel)
                      {instance.tunnel && (
                        <span style={{ color: '#f9e2af', fontSize: 11, marginLeft: 8 }}>· 已配置</span>
                      )}
                    </button>
                    <p style={{ color: '#6c7086', fontSize: 12, margin: '6px 0 0' }}>
                      可选。通常在「设置 → 全局」配置共享 channel 即可，无需在此填写。仅当该 agent 需要独立 channel 时才配置。
                    </p>

                    {showTunnelAdvanced && (
                      <>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }}>
                          <span style={{ color: '#a6adc8', fontSize: 13, fontWeight: 600 }}>Tunnel (Shepaw Channel Service)</span>
                          {instance.tunnel && (
                            <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#f38ba8', fontSize: 12, cursor: 'pointer' }}>
                              <input type="checkbox" checked={editClearTunnel} onChange={(e) => setEditClearTunnel(e.target.checked)} />
                              Remove tunnel
                            </label>
                          )}
                        </div>
                        {!editClearTunnel && (
                          <div style={editGrid}>
                            <div style={editField}>
                              <label style={editLbl}>Server URL</label>
                              <input style={editInp} value={editTunnelServer} onChange={(e) => setEditTunnelServer(e.target.value)} placeholder="https://channel.example.com" />
                            </div>
                            <div style={editField}>
                              <label style={editLbl}>Channel ID</label>
                              <input style={editInp} value={editTunnelChannelId} onChange={(e) => setEditTunnelChannelId(e.target.value)} placeholder="ch_abc123" />
                            </div>
                            <div style={editField}>
                              <label style={editLbl}>Secret</label>
                              <input
                                style={editInp}
                                type={editTunnelSecret === TUNNEL_SECRET_UNCHANGED ? 'text' : 'password'}
                                value={editTunnelSecret === TUNNEL_SECRET_UNCHANGED
                                  ? (instance?.tunnel ? maskSecret(instance.tunnel.secret) : '')
                                  : editTunnelSecret}
                                onChange={(e) => setEditTunnelSecret(e.target.value)}
                                onFocus={() => {
                                  if (editTunnelSecret === TUNNEL_SECRET_UNCHANGED) setEditTunnelSecret('');
                                }}
                                placeholder="Enter new secret to change"
                              />
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>

                  {editErr && <p style={{ color: '#f38ba8', margin: 0, fontSize: 13 }}>{editErr}</p>}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button type="submit" style={editSubmitBtn} disabled={editBusy}>{editBusy ? 'Saving...' : 'Save Changes'}</button>
                    <button type="button" style={editCancelBtn} onClick={() => setShowEdit(false)}>Cancel</button>
                  </div>
                </form>
              )}

              <>
                  <h4 style={sectionTitle}>环境变量</h4>
                  <p style={{ color: '#6c7086', fontSize: 12, margin: '0 0 8px' }}>
                    实例级覆盖；未设置的键会继承引擎默认环境变量。可添加任意自定义键值。
                  </p>
                  {envErr && <p style={{ color: '#f38ba8', fontSize: 13, margin: '0 0 8px' }}>{envErr}</p>}
                  <div style={credTable}>
                    {(instance.envVarKeys ?? []).map((key) => {
                      const isEditing = envEditing[key] !== undefined;
                      const isBusy = envBusy[key] === true;
                      const sensitive = isSensitiveEnvVarKey(key);
                      return (
                        <div key={key} style={credRow}>
                          <code style={{ fontSize: 11, color: '#6c7086' }}>{key}</code>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
                            {isEditing ? (
                              <>
                                <input
                                  style={credInput}
                                  type={sensitive ? 'password' : 'text'}
                                  value={envEditing[key] === ENV_UNCHANGED
                                    ? (envMasked[key] ?? (sensitive ? '••••••••' : ''))
                                    : envEditing[key]}
                                  onChange={(e) => setEnvEditing((prev) => ({ ...prev, [key]: e.target.value }))}
                                  onFocus={() => {
                                    if (envEditing[key] === ENV_UNCHANGED) {
                                      setEnvEditing((prev) => ({
                                        ...prev,
                                        [key]: sensitive ? '' : (envMasked[key] ?? ''),
                                      }));
                                    }
                                  }}
                                  placeholder="Enter new value"
                                  autoFocus
                                />
                                <button style={credSaveBtn} disabled={isBusy} onClick={() => void saveEnvVar(key)}>
                                  {isBusy ? '...' : 'Save'}
                                </button>
                                <button style={credCancelBtn} onClick={() => setEnvEditing((e) => { const n = { ...e }; delete n[key]; return n; })}>
                                  Cancel
                                </button>
                              </>
                            ) : (
                              <>
                                <code style={{
                                  fontSize: 12,
                                  color: sensitive ? '#6c7086' : '#a6e3a1',
                                  fontFamily: 'monospace',
                                  wordBreak: 'break-all',
                                }}>
                                  {envMasked[key] ?? (sensitive ? '••••••••' : '')}
                                </code>
                                <button
                                  style={credEditBtn}
                                  disabled={isBusy}
                                  onClick={() => setEnvEditing((e) => ({ ...e, [key]: ENV_UNCHANGED }))}
                                >
                                  Update
                                </button>
                                <button style={credDeleteBtn} disabled={isBusy} onClick={() => void deleteEnvVar(key)}>
                                  {isBusy ? '...' : 'Clear'}
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    {(instance.envVarKeys ?? []).length === 0 && (
                      <p style={{ color: '#6c7086', fontSize: 12, margin: 0 }}>尚未设置实例级环境变量。</p>
                    )}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
                    {envDrafts.map((row, idx) => {
                      const sensitive = isSensitiveEnvVarKey(row.key);
                      return (
                      <div key={idx} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <input
                          style={credInput}
                          placeholder="变量名"
                          value={row.key}
                          onChange={(e) => setEnvDrafts((prev) => prev.map((r, i) => (i === idx ? { ...r, key: e.target.value } : r)))}
                        />
                        <input
                          style={{ ...credInput, flex: 2, minWidth: 160 }}
                          type={sensitive ? 'password' : 'text'}
                          placeholder={sensitive ? '敏感值' : '值'}
                          value={row.value}
                          onChange={(e) => setEnvDrafts((prev) => prev.map((r, i) => (i === idx ? { ...r, value: e.target.value } : r)))}
                        />
                        {envDrafts.length > 1 && (
                          <button
                            style={credCancelBtn}
                            disabled={envAddBusy}
                            onClick={() => setEnvDrafts((prev) => prev.filter((_, i) => i !== idx))}
                          >
                            移除
                          </button>
                        )}
                      </div>
                      );
                    })}
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button
                        style={credEditBtn}
                        disabled={envAddBusy}
                        onClick={() => setEnvDrafts((prev) => [...prev, { key: '', value: '' }])}
                      >
                        再加一行
                      </button>
                      <button style={credSaveBtn} disabled={envAddBusy} onClick={() => void saveEnvDrafts()}>
                        {envAddBusy ? '保存中…' : '保存环境变量'}
                      </button>
                    </div>
                  </div>
                </>

              {instance.tunnel && (
                <>
                  <h4 style={sectionTitle}>
                    单独的外网 channel (per-instance tunnel){' '}
                    <span style={{ color: '#6c7086', fontSize: 11, fontWeight: 400 }}>· 高级</span>
                  </h4>
                  <p style={{ color: '#6c7086', fontSize: 12, margin: '0 0 8px' }}>
                    该 agent 使用独立 channel 外网可达，与全局共享 channel 互不冲突。如无需独立 channel，可在编辑里移除。
                  </p>
                  <div style={tunnelCard}>
                    <div style={tunnelRow}>
                      <span style={tunnelLabel}>Server</span>
                      <span style={tunnelValue}>{instance.tunnel.serverUrl}</span>
                    </div>
                    <div style={tunnelRow}>
                      <span style={tunnelLabel}>Channel ID</span>
                      <code style={tunnelCode}>{instance.tunnel.channelId}</code>
                    </div>
                    <div style={tunnelRow}>
                      <span style={tunnelLabel}>Secret</span>
                      <code style={{ ...tunnelCode, color: '#cdd6f4' }}>{maskSecret(instance.tunnel.secret)}</code>
                    </div>
                  </div>
                </>
              )}

              <InstanceApprovalSection instance={instance} onChanged={load} />

              <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid #313244' }}>
                <button style={actionBtn('#e74c3c')} onClick={() => void removeInstance()}>
                  删除实例
                </button>
              </div>
            </section>
          )}
        </main>
      </div>

      {showEnroll && (
        <EnrollModal instanceId={instanceId} onClose={() => setShowEnroll(false)} baseUrl={instance?.baseUrl} />
      )}

      {showResume && (
        <SessionResumeModal instanceId={instanceId} onClose={() => setShowResume(false)} />
      )}

      {showDirPicker && (
        <DirectoryPickerModal
          initialPath={editCwd}
          onSelect={(path) => {
            setEditCwd(path);
            setShowDirPicker(false);
          }}
          onClose={() => setShowDirPicker(false)}
        />
      )}
    </div>
  );
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div style={infoItem}>
      <span style={{ color: '#a6adc8', fontSize: 12 }}>{label}</span>
      <span style={{ color: '#cdd6f4', fontSize: 13, wordBreak: 'break-all' }}>{value}</span>
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────────

const backBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', color: '#89b4fa',
  cursor: 'pointer', fontSize: 14, padding: 0,
};

const pageLayout: React.CSSProperties = {
  display: 'flex', gap: 0, alignItems: 'stretch', minHeight: 480,
};

const sidebar: React.CSSProperties = {
  width: 168, flexShrink: 0,
  display: 'flex', flexDirection: 'column', gap: 4,
  padding: '4px 12px 4px 0',
  borderRight: '1px solid #313244',
};

const navBtn = (active: boolean): React.CSSProperties => ({
  background: active ? '#313244' : 'transparent',
  color: active ? '#89b4fa' : '#cdd6f4',
  border: 'none',
  borderRadius: 6,
  padding: '10px 14px',
  cursor: 'pointer',
  fontWeight: active ? 600 : 400,
  fontSize: 14,
  textAlign: 'left',
});

const contentPanel: React.CSSProperties = {
  flex: 1, minWidth: 0, padding: '4px 0 4px 24px',
};

const panelTitle: React.CSSProperties = {
  margin: '0 0 4px', color: '#cdd6f4', fontSize: 16, fontWeight: 600,
};

const panelHint: React.CSSProperties = {
  margin: '0 0 16px', color: '#a6adc8', fontSize: 13,
};

const storeBox: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 10,
  background: '#181825', border: '1px solid #313244', borderRadius: 8, padding: 12,
};

const storeRow: React.CSSProperties = {
  display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12,
};

const storeLabel: React.CSSProperties = {
  color: '#a6adc8', fontSize: 12, marginBottom: 4,
};

const storeUri: React.CSSProperties = {
  display: 'block', color: '#89dceb', fontSize: 11,
  wordBreak: 'break-all', fontFamily: 'ui-monospace, Menlo, monospace',
};

const storeBtn: React.CSSProperties = {
  background: 'transparent', color: '#89b4fa', border: '1px solid #45475a',
  borderRadius: 5, padding: '4px 10px', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap',
};

const panelHeaderRow: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
  gap: 12, marginBottom: 16, flexWrap: 'wrap',
};

const header: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  marginBottom: 16, flexWrap: 'wrap', gap: 12,
  paddingBottom: 16, borderBottom: '1px solid #313244',
};

const badge: React.CSSProperties = {
  fontSize: 11, padding: '2px 7px', background: '#45475a',
  borderRadius: 4, color: '#cdd6f4',
};

function dot(status: Instance['status']): React.CSSProperties {
  return { width: 10, height: 10, borderRadius: '50%', background: availabilityColor(status) };
}

function formatUptime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function actionBtn(bg: string): React.CSSProperties {
  return {
    background: bg, color: '#fff', border: 'none',
    borderRadius: 5, padding: '5px 14px', cursor: 'pointer', fontSize: 13,
  };
}

const infoGrid: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
  gap: 12, marginBottom: 20,
};

const infoItem: React.CSSProperties = {
  background: '#1e1e2e', border: '1px solid #313244',
  borderRadius: 6, padding: '8px 12px',
  display: 'flex', flexDirection: 'column', gap: 2,
};

const sectionTitle: React.CSSProperties = {
  color: '#cdd6f4', borderBottom: '1px solid #313244', paddingBottom: 6, marginBottom: 12,
};

const peerTable: React.CSSProperties = {
  background: '#1e1e2e', border: '1px solid #313244', borderRadius: 6, overflow: 'hidden',
};

const peerRow: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto',
  padding: '8px 14px', gap: 12, alignItems: 'center',
  borderBottom: '1px solid #313244', color: '#a6adc8',
};

const th: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: '#6c7086' };

const removeBtn: React.CSSProperties = {
  background: 'transparent', border: '1px solid #f38ba8',
  color: '#f38ba8', borderRadius: 4, padding: '2px 8px',
  cursor: 'pointer', fontSize: 12,
};

const addPeerBtn: React.CSSProperties = {
  background: 'transparent', border: '1px solid #89b4fa',
  color: '#89b4fa', borderRadius: 4, padding: '3px 10px',
  cursor: 'pointer', fontSize: 12,
};

const addPeerForm: React.CSSProperties = {
  background: '#11111b', border: '1px solid #313244', borderRadius: 6,
  padding: '12px 14px', marginBottom: 12,
  display: 'flex', flexDirection: 'column', gap: 10,
};

const addPeerInput: React.CSSProperties = {
  background: '#1e1e2e', border: '1px solid #45475a', borderRadius: 5,
  color: '#cdd6f4', padding: '6px 10px', fontSize: 13, outline: 'none',
};

const addPeerSubmitBtn: React.CSSProperties = {
  background: '#89b4fa', color: '#11111b', border: 'none',
  borderRadius: 5, padding: '5px 16px', cursor: 'pointer',
  fontWeight: 600, fontSize: 13,
};

const addPeerCancelBtn: React.CSSProperties = {
  background: 'transparent', border: '1px solid #45475a', color: '#a6adc8',
  borderRadius: 5, padding: '5px 14px', cursor: 'pointer', fontSize: 13,
};

const tunnelCard: React.CSSProperties = {
  background: '#1e1e2e', border: '1px solid #313244', borderRadius: 6,
  padding: '10px 14px', marginBottom: 20, display: 'flex', flexDirection: 'column', gap: 8,
};

const tunnelRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 12,
};

const tunnelLabel: React.CSSProperties = {
  color: '#6c7086', fontSize: 12, width: 90, flexShrink: 0,
};

const tunnelValue: React.CSSProperties = {
  color: '#cdd6f4', fontSize: 13, wordBreak: 'break-all',
};

const tunnelCode: React.CSSProperties = {
  color: '#a6e3a1', fontSize: 12, background: '#11111b',
  padding: '2px 6px', borderRadius: 3,
};

const editForm: React.CSSProperties = {
  background: '#11111b', border: '1px solid #f9e2af44',
  borderRadius: 8, padding: '16px 18px', marginBottom: 20,
  display: 'flex', flexDirection: 'column', gap: 14,
};

const editGrid: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 16px',
};

const editField: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 4,
};

const editLbl: React.CSSProperties = { color: '#a6adc8', fontSize: 12 };

const editInp: React.CSSProperties = {
  background: '#1e1e2e', border: '1px solid #45475a', borderRadius: 5,
  color: '#cdd6f4', padding: '6px 10px', fontSize: 13, outline: 'none',
};

const cwdRow: React.CSSProperties = {
  display: 'flex', gap: 8, alignItems: 'stretch',
};

const browseBtn: React.CSSProperties = {
  background: 'transparent', border: '1px solid #45475a', color: '#89b4fa',
  borderRadius: 5, padding: '6px 12px', cursor: 'pointer', fontSize: 12,
  whiteSpace: 'nowrap', flexShrink: 0,
};

const editTunnelSection: React.CSSProperties = {
  background: '#1e1e2e', border: '1px solid #313244',
  borderRadius: 6, padding: '10px 12px',
  display: 'flex', flexDirection: 'column', gap: 10,
};

const tunnelAdvancedToggle: React.CSSProperties = {
  background: 'none', border: 'none', color: '#a6adc8', cursor: 'pointer',
  fontSize: 13, fontWeight: 600, padding: 0, textAlign: 'left',
};

const editSubmitBtn: React.CSSProperties = {
  background: '#f9e2af', color: '#11111b', border: 'none',
  borderRadius: 5, padding: '6px 18px', cursor: 'pointer',
  fontWeight: 600, fontSize: 13,
};

const editCancelBtn: React.CSSProperties = {
  background: 'transparent', border: '1px solid #45475a', color: '#a6adc8',
  borderRadius: 5, padding: '6px 14px', cursor: 'pointer', fontSize: 13,
};

const credTable: React.CSSProperties = {
  background: '#1e1e2e', border: '1px solid #313244', borderRadius: 6,
  overflow: 'hidden', marginBottom: 20,
};

const credRow: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  padding: '10px 14px', borderBottom: '1px solid #313244', gap: 12,
  flexWrap: 'wrap',
};

const credInput: React.CSSProperties = {
  background: '#11111b', border: '1px solid #45475a', borderRadius: 4,
  color: '#cdd6f4', padding: '4px 8px', fontSize: 13, outline: 'none',
  width: 240,
};

const credEditBtn: React.CSSProperties = {
  background: 'transparent', border: '1px solid #89b4fa', color: '#89b4fa',
  borderRadius: 4, padding: '2px 10px', cursor: 'pointer', fontSize: 12,
};

const credSaveBtn: React.CSSProperties = {
  background: '#89b4fa', color: '#11111b', border: 'none',
  borderRadius: 4, padding: '3px 10px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
};

const credCancelBtn: React.CSSProperties = {
  background: 'transparent', border: '1px solid #45475a', color: '#a6adc8',
  borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontSize: 12,
};

const credDeleteBtn: React.CSSProperties = {
  background: 'transparent', border: '1px solid #f38ba8', color: '#f38ba8',
  borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontSize: 12,
};

// ── QR code section styles ────────────────────────────────────────

const qrSection: React.CSSProperties = {
  background: '#11111b', border: '1px solid #89dceb44',
  borderRadius: 8, marginBottom: 20, overflow: 'hidden',
};

const qrSectionHeader: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  padding: '10px 14px', borderBottom: '1px solid #313244',
  background: '#1e1e2e',
};

const qrBody: React.CSSProperties = {
  padding: '16px 20px',
};

const qrContentWrap: React.CSSProperties = {
  display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap',
};

const qrCodeWrap: React.CSSProperties = {
  padding: 16, background: '#1e1e2e', borderRadius: 8,
  border: '1px solid #313244', flexShrink: 0,
};

const qrInfoBlock: React.CSSProperties = {
  flex: 1, minWidth: 200,
};

const qrInfoRow: React.CSSProperties = {
  margin: '8px 0', display: 'flex', gap: 12,
  alignItems: 'flex-start', color: '#cdd6f4', fontSize: 14,
};

const qrInfoLabel: React.CSSProperties = {
  color: '#a6adc8', minWidth: 64, fontWeight: 500, fontSize: 13,
};

const qrCodeBox: React.CSSProperties = {
  background: '#313244', padding: '2px 8px', borderRadius: 4,
  fontSize: 14, letterSpacing: 2, color: '#cba6f7',
};

const qrRefreshBtn: React.CSSProperties = {
  background: 'transparent', border: '1px solid #89dceb',
  color: '#89dceb', borderRadius: 4, padding: '2px 10px',
  cursor: 'pointer', fontSize: 12,
};

const qrCloseBtn: React.CSSProperties = {
  background: 'transparent', border: 'none',
  color: '#6c7086', fontSize: 16, cursor: 'pointer', padding: '0 2px',
};
