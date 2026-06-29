import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { api } from '../api/client.js';
import type { Project, Peer, AgentEngine, EnrollToken } from '../api/types.js';
import { LogViewer } from './LogViewer.js';
import { EnrollModal } from './EnrollModal.js';
import { SessionResumeModal } from './SessionResumeModal.js';
import { maskSecret } from '../utils/maskSecret.js';

// ── engine credential field definitions ───────────────────────────

interface CredField {
  key: string;
  label: string;
  required?: boolean;
  type?: 'password' | 'text';
}

const ENGINE_CREDS: Record<AgentEngine, CredField[]> = {
  'codebuddy': [
    { key: 'CODEBUDDY_API_KEY', label: 'API Key', type: 'password' },
    { key: 'CODEBUDDY_AUTH_TOKEN', label: 'Auth Token', type: 'password' },
  ],
  'claude-code': [
    { key: 'ANTHROPIC_API_KEY', label: 'API Key', required: true, type: 'password' },
    { key: 'ANTHROPIC_AUTH_TOKEN', label: 'Auth Token (alternative)', type: 'password' },
    { key: 'ANTHROPIC_BASE_URL', label: 'Base URL (custom endpoint)', type: 'text' },
  ],
  'codex': [
    { key: 'OPENAI_API_KEY', label: 'API Key', type: 'password' },
    { key: 'OPENAI_BASE_URL', label: 'Base URL (custom endpoint)', type: 'text' },
  ],
  'opencode': [],
  'openclaw': [],
  'cursor': [],
  'hermes': [],
};

interface ProjectDetailProps {
  projectId: string;
  onBack: () => void;
  onReload: () => void;
}

export function ProjectDetail({ projectId, onBack, onReload }: ProjectDetailProps) {
  const [project, setProject] = useState<Project | null>(null);
  const [peers, setPeers] = useState<Peer[]>([]);
  // key -> masked display value, populated from GET /envvars
  const [envMasked, setEnvMasked] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showEnroll, setShowEnroll] = useState(false);
  const [showResume, setShowResume] = useState(false);
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
  const [editErr, setEditErr] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);

  const load = async () => {
    try {
      const [p, ps, envvars] = await Promise.all([
        api.projects.get(projectId),
        api.peers.list(projectId),
        api.envvars.list(projectId).catch(() => [] as { key: string; value: string }[]),
      ]);
      setProject(p);
      setPeers(ps);
      // Build key -> masked string map
      const masked: Record<string, string> = {};
      for (const { key, value } of envvars) masked[key] = value;
      setEnvMasked(masked);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [projectId]);

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
      const t = await api.enroll.mint(projectId, {
        ttlMinutes: 10,
        baseUrl: project?.baseUrl || undefined,
      });
      setQrToken(t);
    } catch (e) {
      setQrErr(e instanceof Error ? e.message : String(e));
    } finally {
      setQrLoading(false);
    }
  };

  const openQr = () => {
    setShowQr(true);
    if (!qrToken) void mintQr();
  };

  const toggle = async () => {
    if (!project) return;
    setBusy(true);
    setErr(null);
    try {
      if (project.status.running) {
        await api.projects.stop(project.id);
      } else {
        await api.projects.start(project.id);
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
      await api.peers.add(projectId, addPeerPubkey.trim(), addPeerLabel.trim() || undefined);
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
      await api.envvars.set(projectId, key, value);
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
      await api.envvars.remove(projectId, key);
      await load();
    } catch (e) {
      setEnvErr(e instanceof Error ? e.message : String(e));
    } finally {
      setEnvBusy((b) => { const n = { ...b }; delete n[key]; return n; });
    }
  };

  // Sentinels for "value not changed" — used for tunnel secret and env var fields.
  const TUNNEL_SECRET_UNCHANGED = '\x00unchanged';
  const ENV_UNCHANGED = '\x00unchanged';

  const openEdit = (p: typeof project) => {    if (!p) return;
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
      const isNewTunnel = hasTunnelFields && !project?.tunnel; // no prior tunnel
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
      await api.projects.update(projectId, {
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
      await api.peers.remove(projectId, fp);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const removeProject = async () => {
    if (!confirm(`Remove project "${projectId}"?`)) return;
    try {
      await api.projects.remove(projectId);
      onReload();
      onBack();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  if (loading) return <p style={{ color: '#a6adc8' }}>Loading...</p>;
  if (!project) return <p style={{ color: '#f38ba8' }}>{err ?? 'Not found'}</p>;

  return (
    <div>
      {/* Back */}
      <button style={backBtn} onClick={onBack}>← Back</button>

      {/* Header */}
      <div style={header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={dot(project.status.running)} />
          <h2 style={{ margin: 0, color: '#cdd6f4' }}>{project.label}</h2>
          <code style={badge}>{project.id}</code>
          <code style={{ ...badge, background: '#313244' }}>{project.engine}</code>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            style={actionBtn(project.status.running ? '#c0392b' : '#27ae60')}
            disabled={busy}
            onClick={() => void toggle()}
          >
            {busy ? '...' : project.status.running ? 'Stop' : 'Start'}
          </button>
          <button style={actionBtn('#89dceb')} onClick={openQr}>
            📷 Scan to Connect
          </button>
          <button style={actionBtn('#8e44ad')} onClick={() => setShowEnroll(true)}>
            Pair Device
          </button>
          <button style={actionBtn('#94e2d5')} onClick={() => setShowResume(true)}>
            Resume Session
          </button>
          <button style={actionBtn('#f9e2af')} onClick={() => openEdit(project)}>
            Edit
          </button>
          <button style={actionBtn('#e74c3c')} onClick={() => void removeProject()}>
            Remove
          </button>
        </div>
      </div>

      {err && <p style={{ color: '#f38ba8', margin: '8px 0' }}>{err}</p>}

      {/* Inline QR Code Section */}
      {showQr && (
        <div style={qrSection}>
          <div style={qrSectionHeader}>
            <span style={{ color: '#cdd6f4', fontWeight: 600, fontSize: 14 }}>📷 连接二维码</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {qrToken && qrSecondsLeft > 0 && (
                <span style={{ color: qrSecondsLeft <= 60 ? '#f38ba8' : '#a6adc8', fontSize: 12 }}>
                  {Math.floor(qrSecondsLeft / 60)}:{String(qrSecondsLeft % 60).padStart(2, '0')} 后过期
                </span>
              )}
              <button style={qrRefreshBtn} disabled={qrLoading} onClick={() => void mintQr()}>
                {qrLoading ? '生成中...' : '↻ 刷新'}
              </button>
              <button style={qrCloseBtn} onClick={() => { setShowQr(false); setQrToken(null); setQrErr(null); }}>✕</button>
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
              <p style={{ color: '#a6adc8', margin: 0, fontSize: 13 }}>点击"刷新"生成新的二维码。</p>
            )}
          </div>
        </div>
      )}

      {/* Edit form */}
      {showEdit && (
        <form onSubmit={(e) => void submitEdit(e)} style={editForm}>
          <div style={editGrid}>
            <div style={editField}>
              <label style={editLbl}>Label</label>
              <input style={editInp} value={editLabel} onChange={(e) => setEditLabel(e.target.value)} placeholder={projectId} />
            </div>
            <div style={editField}>
              <label style={editLbl}>Working Directory <span style={{ color: '#f38ba8' }}>*</span></label>
              <input style={editInp} value={editCwd} onChange={(e) => setEditCwd(e.target.value)} placeholder="/path/to/project" required />
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
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ color: '#a6adc8', fontSize: 13, fontWeight: 600 }}>Tunnel (Shepaw Channel Service)</span>
              {project.tunnel && (
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
                      ? (project?.tunnel ? maskSecret(project.tunnel.secret) : '')
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
          </div>

          {editErr && <p style={{ color: '#f38ba8', margin: 0, fontSize: 13 }}>{editErr}</p>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" style={editSubmitBtn} disabled={editBusy}>{editBusy ? 'Saving...' : 'Save Changes'}</button>
            <button type="button" style={editCancelBtn} onClick={() => setShowEdit(false)}>Cancel</button>
          </div>
        </form>
      )}

      {/* Info grid */}
      <div style={infoGrid}>
        <InfoItem label="Bind" value={`${project.host}:${project.port}`} />
        <InfoItem label="CWD" value={project.cwd} />
        {project.baseUrl && <InfoItem label="Base URL" value={project.baseUrl} />}
        <InfoItem label="Status" value={project.status.running ? `Running (PID ${project.status.pid})` : 'Stopped'} />
        {project.status.startedAt && <InfoItem label="Started" value={new Date(project.status.startedAt).toLocaleString()} />}
        {project.status.stoppedAt && <InfoItem label="Stopped" value={new Date(project.status.stoppedAt).toLocaleString()} />}
        <InfoItem label="Created" value={new Date(project.createdAt).toLocaleString()} />
      </div>

      {/* Credentials */}
      {(() => {
        const fields = ENGINE_CREDS[project.engine] ?? [];
        // Also show any custom keys not in the predefined list
        const knownKeys = new Set(fields.map((f) => f.key));
        const extraKeys = (project.envVarKeys ?? []).filter((k) => !knownKeys.has(k));
        const allFields: CredField[] = [
          ...fields,
          ...extraKeys.map((k) => ({ key: k, label: k, type: 'password' as const })),
        ];
        if (allFields.length === 0 && (project.envVarKeys ?? []).length === 0) return null;
        return (
          <>
            <h4 style={sectionTitle}>Credentials</h4>
            {envErr && <p style={{ color: '#f38ba8', fontSize: 13, margin: '0 0 8px' }}>{envErr}</p>}
            <div style={credTable}>
              {allFields.map((field) => {
                const isSet = (project.envVarKeys ?? []).includes(field.key);
                const isEditing = envEditing[field.key] !== undefined;
                const isBusy = envBusy[field.key] === true;
                return (
                  <div key={field.key} style={credRow}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontSize: 12, color: '#a6adc8' }}>
                        {field.label}
                        {field.required && <span style={{ color: '#f38ba8' }}> *</span>}
                      </span>
                      <code style={{ fontSize: 11, color: '#6c7086' }}>{field.key}</code>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
                      {isEditing ? (
                        <>
                          <input
                            style={credInput}
                            type={envEditing[field.key] === ENV_UNCHANGED ? 'text' : (field.type ?? 'password')}
                            value={envEditing[field.key] === ENV_UNCHANGED
                              ? (envMasked[field.key] ?? '••••••••')
                              : envEditing[field.key]}
                            onChange={(e) => setEnvEditing((prev) => ({ ...prev, [field.key]: e.target.value }))}
                            onFocus={() => {
                              if (envEditing[field.key] === ENV_UNCHANGED)
                                setEnvEditing((prev) => ({ ...prev, [field.key]: '' }));
                            }}
                            placeholder={isSet ? 'Enter new value to change' : `Enter ${field.label}`}
                            autoFocus
                          />
                          <button style={credSaveBtn} disabled={isBusy} onClick={() => void saveEnvVar(field.key)}>
                            {isBusy ? '...' : 'Save'}
                          </button>
                          <button style={credCancelBtn} onClick={() => setEnvEditing((e) => { const n = { ...e }; delete n[field.key]; return n; })}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          {isSet
                            ? <code style={{ fontSize: 12, color: '#a6e3a1', fontFamily: 'monospace' }}>
                                {envMasked[field.key] ?? '••••••••'}
                              </code>
                            : <span style={{ fontSize: 12, color: '#6c7086', fontStyle: 'italic' }}>not set</span>
                          }
                          <button
                            style={credEditBtn}
                            disabled={isBusy}
                            onClick={() => setEnvEditing((e) => ({
                              ...e,
                              // Pre-fill sentinel for existing keys so user sees the masked value
                              [field.key]: isSet ? ENV_UNCHANGED : '',
                            }))}
                          >
                            {isSet ? 'Update' : 'Set'}
                          </button>
                          {isSet && (
                            <button style={credDeleteBtn} disabled={isBusy} onClick={() => void deleteEnvVar(field.key)}>
                              {isBusy ? '...' : 'Clear'}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        );
      })()}

      {/* Tunnel info */}
      {project.tunnel && (        <>
          <h4 style={sectionTitle}>Tunnel (Shepaw Channel Service)</h4>
          <div style={tunnelCard}>
            <div style={tunnelRow}>
              <span style={tunnelLabel}>Server</span>
              <span style={tunnelValue}>{project.tunnel.serverUrl}</span>
            </div>
            <div style={tunnelRow}>
              <span style={tunnelLabel}>Channel ID</span>
              <code style={tunnelCode}>{project.tunnel.channelId}</code>
            </div>
            <div style={tunnelRow}>
              <span style={tunnelLabel}>Secret</span>
              <code style={{ ...tunnelCode, color: '#cdd6f4' }}>{maskSecret(project.tunnel.secret)}</code>
            </div>
          </div>
        </>
      )}

      {/* Logs */}
      <h4 style={sectionTitle}>Logs</h4>
      <LogViewer projectId={projectId} />

      {/* Peers */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, borderBottom: '1px solid #313244', paddingBottom: 6 }}>
        <h4 style={{ ...sectionTitle, margin: 0, border: 'none', padding: 0 }}>Authorized Devices ({peers.length})</h4>
        <button style={addPeerBtn} onClick={() => { setShowAddPeer((v) => !v); setAddPeerErr(null); }}>
          {showAddPeer ? '✕ Cancel' : '+ Add Device'}
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
            <button type="button" style={addPeerCancelBtn} onClick={() => { setShowAddPeer(false); setAddPeerErr(null); }}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {peers.length === 0 ? (
        <p style={{ color: '#a6adc8', fontSize: 14 }}>
          No authorized peers. Use "Pair Device" or "Add Device" to add one.
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

      {showEnroll && (
        <EnrollModal projectId={projectId} onClose={() => setShowEnroll(false)} baseUrl={project?.baseUrl} />
      )}

      {showResume && (
        <SessionResumeModal projectId={projectId} onClose={() => setShowResume(false)} />
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
  cursor: 'pointer', fontSize: 14, padding: 0, marginBottom: 16,
};

const header: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  marginBottom: 16, flexWrap: 'wrap', gap: 12,
};

const badge: React.CSSProperties = {
  fontSize: 11, padding: '2px 7px', background: '#45475a',
  borderRadius: 4, color: '#cdd6f4',
};

function dot(running: boolean): React.CSSProperties {
  return { width: 10, height: 10, borderRadius: '50%', background: running ? '#a6e3a1' : '#6c7086' };
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

const editTunnelSection: React.CSSProperties = {
  background: '#1e1e2e', border: '1px solid #313244',
  borderRadius: 6, padding: '10px 12px',
  display: 'flex', flexDirection: 'column', gap: 10,
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
