import { useState, useEffect } from 'react';
import { api } from '../api/client.js';
import type { EngineInfo, HubMeta } from '../api/types.js';
import { DirectoryPickerModal } from './DirectoryPickerModal.js';

const FALLBACK_ENGINES = [
  'codebuddy', 'claude-code', 'codex',
  'opencode', 'openclaw', 'cursor', 'hermes', 'kimi',
];

/** Survives modal unmount so closing without submit keeps the draft. */
interface AddInstanceDraft {
  label: string;
  engine: string;
  cwd: string;
  host: string;
  baseUrl: string;
  tunnelServer: string;
  tunnelChannelId: string;
  tunnelSecret: string;
  showTunnel: boolean;
}

const EMPTY_DRAFT: AddInstanceDraft = {
  label: '',
  engine: '',
  cwd: '',
  host: '127.0.0.1',
  baseUrl: '',
  tunnelServer: '',
  tunnelChannelId: '',
  tunnelSecret: '',
  showTunnel: false,
};

let draft: AddInstanceDraft = { ...EMPTY_DRAFT };

function clearDraft() {
  draft = { ...EMPTY_DRAFT };
}

interface AddInstanceModalProps {
  onClose: () => void;
  onCreated: () => void;
  onOpenEngineSettings: (engineId: string) => void;
}

export function AddInstanceModal({ onClose, onCreated, onOpenEngineSettings }: AddInstanceModalProps) {
  const [label, setLabel] = useState(draft.label);
  const [engine, setEngine] = useState(draft.engine);
  const [engineOptions, setEngineOptions] = useState<EngineInfo[]>([]);
  const [cwd, setCwd] = useState(draft.cwd);
  const [host, setHost] = useState(draft.host);
  const [baseUrl, setBaseUrl] = useState(draft.baseUrl);

  const [tunnelServer, setTunnelServer] = useState(draft.tunnelServer);
  const [tunnelChannelId, setTunnelChannelId] = useState(draft.tunnelChannelId);
  const [tunnelSecret, setTunnelSecret] = useState(draft.tunnelSecret);
  const [showTunnel, setShowTunnel] = useState(draft.showTunnel);

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hubMeta, setHubMeta] = useState<HubMeta | null>(null);
  const [showDirPicker, setShowDirPicker] = useState(false);

  // Keep draft in sync while editing; reopen restores these values.
  useEffect(() => {
    draft = {
      label,
      engine,
      cwd,
      host,
      baseUrl,
      tunnelServer,
      tunnelChannelId,
      tunnelSecret,
      showTunnel,
    };
  }, [label, engine, cwd, host, baseUrl, tunnelServer, tunnelChannelId, tunnelSecret, showTunnel]);

  useEffect(() => {
    api.engines.list()
      .then(({ engines }) => {
        setEngineOptions(engines);
        setEngine((current) => {
          if (current && engines.some((e) => e.id === current)) return current;
          const firstAvailable = engines.find((e) => e.available !== false);
          if (firstAvailable) return firstAvailable.id;
          if (engines.length > 0) return engines[0]!.id;
          return current;
        });
      })
      .catch(() => { /* fallback engine ids below */ });
  }, []);

  const selectedEngine = engineOptions.find((e) => e.id === engine);
  const selectedUnavailable = selectedEngine?.available === false;
  const hasAvailableEngine = engineOptions.some((e) => e.available !== false);

  useEffect(() => {
    api.instances.meta().then((meta) => {
      setHubMeta(meta);
    }).catch(() => { /* optional UX enhancement */ });
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedUnavailable) {
      setErr(selectedEngine?.unavailableReason ?? '所选引擎当前不可用，请先完成环境安装。');
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const server = tunnelServer.trim();
      const channelId = tunnelChannelId.trim();
      const effectiveSecret = (tunnelSecret === '__use_cache__' ? '' : tunnelSecret).trim();
      const hasTunnel = Boolean(server && channelId && effectiveSecret);
      if ((server || channelId || effectiveSecret) && !hasTunnel) {
        setErr('填写 channel 时须同时提供 Server URL、Channel ID 与 Secret，或全部留空。');
        setLoading(false);
        return;
      }
      const tunnel = hasTunnel
        ? { serverUrl: server, channelId, secret: effectiveSecret }
        : undefined;

      const resolvedBaseUrl = baseUrl.trim() || (tunnel ? `${tunnel.serverUrl}/proxy/${tunnel.channelId}` : '');

      await api.instances.create({
        label: label || undefined,
        engine,
        cwd,
        host,
        baseUrl: resolvedBaseUrl,
        tunnel,
      });
      clearDraft();
      onCreated();
      onClose();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={overlay}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <h3 style={{ margin: 0, color: '#cdd6f4' }}>Add Instance</h3>
          <button style={closeBtn} onClick={onClose}>✕</button>
        </div>

        <form onSubmit={(e) => void submit(e)} style={form}>
          <p style={{ color: '#6c7086', fontSize: 12, margin: '0 0 8px' }}>
            Upstream ACP agents handle their own login and API keys on the gateway host.
            Hub only spawns the agent CLI — no credentials needed here.
            Agent ID is auto-generated and shared with the Shepaw app.
          </p>

          <label style={lbl}>Label</label>
          <input style={inp} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="My Agent" />

          <label style={lbl}>Engine <span style={req}>*</span></label>
          {engineOptions.length > 0 ? (
            <div style={engineList} role="listbox" aria-label="Engine">
              {engineOptions.map((e) => {
                const unavailable = e.available === false;
                const selected = engine === e.id;
                const title = e.builtin ? e.displayName : `${e.displayName} (custom)`;
                return (
                  <div
                    key={e.id}
                    role="option"
                    aria-selected={selected}
                    aria-disabled={unavailable}
                    style={{
                      ...engineRow,
                      ...(selected ? engineRowSelected : {}),
                      ...(unavailable ? engineRowUnavailable : {}),
                    }}
                    onClick={() => setEngine(e.id)}
                  >
                    <div style={engineRowMain}>
                      <span style={engineRadio}>{selected ? '●' : '○'}</span>
                      <div style={engineRowText}>
                        <span style={{ color: unavailable ? '#a6adc8' : '#cdd6f4' }}>
                          {title}
                          {unavailable ? ' — 不可用' : ''}
                        </span>
                        {unavailable && e.unavailableReason && (
                          <span style={engineReason}>{e.unavailableReason}</span>
                        )}
                      </div>
                    </div>
                    {unavailable && (
                      <button
                        type="button"
                        style={installLinkBtn}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          onOpenEngineSettings(e.id);
                        }}
                      >
                        去配置 →
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <select
              style={inp}
              value={engine}
              onChange={(e) => setEngine(e.target.value)}
              required
            >
              {FALLBACK_ENGINES.map((id) => (
                <option key={id} value={id}>{id}</option>
              ))}
            </select>
          )}

          {selectedUnavailable && (
            <div style={unavailableBox}>
              <p style={{ margin: 0, color: '#f38ba8', fontSize: 13 }}>
                {selectedEngine?.unavailableReason ?? '该引擎运行环境未就绪，无法创建实例。'}
              </p>
              <button
                type="button"
                style={installLinkBtn}
                onClick={() => onOpenEngineSettings(engine)}
              >
                前往引擎设置配置 →
              </button>
            </div>
          )}

          {!hasAvailableEngine && engineOptions.length > 0 && (
            <p style={{ color: '#fab387', fontSize: 12, margin: '4px 0 0' }}>
              当前没有可用引擎。请点击上方「去配置」完成安装与凭据设置。
            </p>
          )}

          <label style={lbl}>Working Directory <span style={req}>*</span></label>
          <div style={cwdRow}>
            <input
              style={{ ...inp, flex: 1, minWidth: 0 }}
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
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

          <label style={lbl}>Bind Host</label>
          <select style={inp} value={host} onChange={(e) => setHost(e.target.value)}>
            <option value="127.0.0.1">127.0.0.1 (loopback only)</option>
            <option value="0.0.0.0">0.0.0.0 (all interfaces)</option>
          </select>

          <label style={lbl}>Base URL <span style={{ color: '#6c7086', fontSize: 11 }}>(optional — auto-derived from tunnel)</span></label>
          <input style={inp} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="wss://example.com (leave blank if using tunnel)" />

          <button
            type="button"
            style={tunnelToggle}
            onClick={() => setShowTunnel((v) => !v)}
          >
            {showTunnel ? '▼' : '▶'} 高级:单独的外网 channel (per-instance tunnel)
          </button>

          {showTunnel && (
            <div style={tunnelBox}>
              <p style={tunnelNote}>
                可选。通常在「设置 → Peer 配对」配置共享 channel 即可让所有 agent 外网可达，无需在此填写。
                仅当该 agent 需要独立的 channel 时才配置；三项须同时填写，留空则跳过。
              </p>
              <label style={lbl}>Server URL</label>
              <input
                style={inp}
                value={tunnelServer}
                onChange={(e) => setTunnelServer(e.target.value)}
                placeholder={hubMeta?.lastTunnelServerUrl ?? 'https://channel.example.com'}
              />
              <label style={lbl}>Channel ID</label>
              <input
                style={inp}
                value={tunnelChannelId}
                onChange={(e) => setTunnelChannelId(e.target.value)}
                placeholder="ch_abc123"
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label style={lbl}>Secret</label>
                {hubMeta?.lastTunnelSecretHint && (
                  <button
                    type="button"
                    style={hintToggleBtn}
                    onClick={() => setTunnelSecret((v) => v ? '' : '__use_cache__')}
                    title="Click to toggle cached secret"
                  >
                    {tunnelSecret === '__use_cache__'
                      ? `Using: ${hubMeta.lastTunnelSecretHint}`
                      : `Cached: ${hubMeta.lastTunnelSecretHint}`}
                  </button>
                )}
              </div>
              {tunnelSecret === '__use_cache__' ? (
                <div style={cachedValueDisplay}>
                  <span style={{ color: '#a6e3a1', fontSize: 13 }}>{hubMeta?.lastTunnelSecretHint}</span>
                  <span style={{ color: '#6c7086', fontSize: 12, marginLeft: 8 }}>(cached — click above to change)</span>
                </div>
              ) : (
                <input
                  style={inp}
                  type="password"
                  value={tunnelSecret}
                  onChange={(e) => setTunnelSecret(e.target.value)}
                  placeholder={hubMeta?.lastTunnelSecretHint ? 'Enter new secret to override cached' : 'HMAC-SHA256 signing secret'}
                />
              )}
            </div>
          )}

          {err && <p style={{ color: '#f38ba8', margin: '4px 0' }}>{err}</p>}

          <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
            <button type="submit" style={submitBtn} disabled={loading || selectedUnavailable || !engine}>
              {loading ? 'Creating...' : 'Create Instance'}
            </button>
            <button type="button" style={cancelBtn} onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>

      {showDirPicker && (
        <DirectoryPickerModal
          initialPath={cwd}
          onSelect={(path) => {
            setCwd(path);
            setShowDirPicker(false);
          }}
          onClose={() => setShowDirPicker(false)}
        />
      )}
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0,
  background: 'rgba(0,0,0,0.6)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 100,
};
const modal: React.CSSProperties = {
  background: '#1e1e2e', border: '1px solid #45475a',
  borderRadius: 10, width: '90%', maxWidth: 480,
  maxHeight: '90vh', overflowY: 'auto',
};
const header: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  padding: '14px 20px', borderBottom: '1px solid #313244',
};
const closeBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', color: '#a6adc8', fontSize: 18, cursor: 'pointer',
};
const form: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 8, padding: 20,
};
const lbl: React.CSSProperties = { color: '#a6adc8', fontSize: 13 };
const req: React.CSSProperties = { color: '#f38ba8' };
const inp: React.CSSProperties = {
  background: '#11111b', border: '1px solid #45475a', borderRadius: 5,
  color: '#cdd6f4', padding: '6px 10px', fontSize: 14, outline: 'none',
};
const cwdRow: React.CSSProperties = {
  display: 'flex', gap: 8, alignItems: 'stretch',
};
const browseBtn: React.CSSProperties = {
  background: 'transparent', border: '1px solid #45475a', color: '#89b4fa',
  borderRadius: 5, padding: '6px 12px', cursor: 'pointer', fontSize: 13,
  whiteSpace: 'nowrap', flexShrink: 0,
};
const submitBtn: React.CSSProperties = {
  background: '#89b4fa', color: '#11111b', border: 'none',
  borderRadius: 6, padding: '7px 18px', cursor: 'pointer', fontWeight: 600,
};
const cancelBtn: React.CSSProperties = {
  background: 'transparent', border: '1px solid #45475a', color: '#a6adc8',
  borderRadius: 6, padding: '7px 18px', cursor: 'pointer',
};
const tunnelToggle: React.CSSProperties = {
  background: 'transparent', border: '1px solid #45475a', color: '#a6adc8',
  borderRadius: 5, padding: '5px 10px', cursor: 'pointer', fontSize: 13,
  textAlign: 'left', marginTop: 4,
};
const tunnelBox: React.CSSProperties = {
  background: '#11111b', border: '1px solid #313244', borderRadius: 6,
  padding: 12, display: 'flex', flexDirection: 'column', gap: 6,
};
const tunnelNote: React.CSSProperties = {
  color: '#6c7086', fontSize: 12, margin: '0 0 4px',
};
const hintToggleBtn: React.CSSProperties = {
  background: 'transparent', border: '1px solid #313244', color: '#89b4fa',
  borderRadius: 4, padding: '2px 8px', fontSize: 11, cursor: 'pointer',
  fontFamily: 'monospace', whiteSpace: 'nowrap',
};
const cachedValueDisplay: React.CSSProperties = {
  background: '#11111b', border: '1px solid #313244', borderRadius: 5,
  padding: '6px 10px', fontSize: 13, fontFamily: 'monospace',
  display: 'flex', alignItems: 'center',
};
const unavailableBox: React.CSSProperties = {
  background: '#45263233', border: '1px solid #f38ba866', borderRadius: 6,
  padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8,
};
const installLinkBtn: React.CSSProperties = {
  flexShrink: 0, alignSelf: 'center', background: 'transparent', border: '1px solid #89b4fa',
  color: '#89b4fa', borderRadius: 5, padding: '4px 10px', cursor: 'pointer', fontSize: 12,
  whiteSpace: 'nowrap',
};
const engineList: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 6,
  maxHeight: 220, overflowY: 'auto',
  background: '#11111b', border: '1px solid #45475a', borderRadius: 6, padding: 6,
};
const engineRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
  padding: '8px 10px', borderRadius: 5, cursor: 'pointer',
  border: '1px solid transparent',
};
const engineRowSelected: React.CSSProperties = {
  background: '#313244', border: '1px solid #89b4fa66',
};
const engineRowUnavailable: React.CSSProperties = {
  opacity: 0.92,
};
const engineRowMain: React.CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: 8, minWidth: 0, flex: 1,
};
const engineRadio: React.CSSProperties = {
  color: '#89b4fa', fontSize: 12, lineHeight: '18px', flexShrink: 0,
};
const engineRowText: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0,
  fontSize: 13, lineHeight: 1.35,
};
const engineReason: React.CSSProperties = {
  color: '#6c7086', fontSize: 11, lineHeight: 1.35,
  overflow: 'hidden', textOverflow: 'ellipsis',
  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
};
