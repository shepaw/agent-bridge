import { useState, useEffect } from 'react';
import { api } from '../api/client.js';
import type { EngineInfo, HubMeta } from '../api/types.js';

const FALLBACK_ENGINES = [
  'codebuddy', 'claude-code', 'codex',
  'opencode', 'openclaw', 'cursor', 'hermes',
];

interface AddInstanceModalProps {
  onClose: () => void;
  onCreated: () => void;
  onOpenEngineSettings: (engineId: string) => void;
}

export function AddInstanceModal({ onClose, onCreated, onOpenEngineSettings }: AddInstanceModalProps) {
  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [engine, setEngine] = useState<string>('');
  const [engineOptions, setEngineOptions] = useState<EngineInfo[]>([]);
  const [cwd, setCwd] = useState('');
  const [host, setHost] = useState('127.0.0.1');
  const [baseUrl, setBaseUrl] = useState('');

  const [tunnelServer, setTunnelServer] = useState('');
  const [tunnelChannelId, setTunnelChannelId] = useState('');
  const [tunnelSecret, setTunnelSecret] = useState('');
  const [showTunnel, setShowTunnel] = useState(false);

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hubMeta, setHubMeta] = useState<HubMeta | null>(null);

  useEffect(() => {
    api.engines.list()
      .then(({ engines }) => {
        setEngineOptions(engines);
        const firstAvailable = engines.find((e) => e.available !== false);
        if (firstAvailable) setEngine(firstAvailable.id);
        else if (engines.length > 0) setEngine(engines[0]!.id);
      })
      .catch(() => { /* fallback engine ids below */ });
  }, []);

  const selectedEngine = engineOptions.find((e) => e.id === engine);
  const selectedUnavailable = selectedEngine?.available === false;
  const hasAvailableEngine = engineOptions.some((e) => e.available !== false);

  useEffect(() => {
    api.instances.meta().then((meta) => {
      setHubMeta(meta);
      if (meta.lastTunnelServerUrl) {
        setTunnelServer(meta.lastTunnelServerUrl);
      }
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
      const effectiveSecret = tunnelSecret === '__use_cache__' ? '' : tunnelSecret;
      const hasTunnel = tunnelServer && tunnelChannelId && effectiveSecret;
      if ((tunnelServer || tunnelChannelId || effectiveSecret) && !hasTunnel) {
        setErr('All three tunnel fields (server, channel ID, secret) are required together.');
        setLoading(false);
        return;
      }
      const tunnel = hasTunnel
        ? { serverUrl: tunnelServer, channelId: tunnelChannelId, secret: effectiveSecret }
        : undefined;

      const resolvedBaseUrl = baseUrl || (tunnel ? `${tunnel.serverUrl}/proxy/${tunnel.channelId}` : '');

      await api.instances.create({
        id,
        label: label || id,
        engine,
        cwd,
        host,
        baseUrl: resolvedBaseUrl,
        tunnel,
      });
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
          </p>

          <label style={lbl}>ID <span style={req}>*</span></label>
          <input style={inp} value={id} onChange={(e) => setId(e.target.value)} placeholder="my-instance" required />

          <label style={lbl}>Label</label>
          <input style={inp} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="My Instance" />

          <label style={lbl}>Engine <span style={req}>*</span></label>
          <select
            style={inp}
            value={engine}
            onChange={(e) => setEngine(e.target.value)}
            required
          >
            {engineOptions.length > 0
              ? engineOptions.map((e) => (
                <option key={e.id} value={e.id} disabled={e.available === false}>
                  {e.builtin ? e.displayName : `${e.displayName} (custom)`}
                  {e.available === false ? ' — 不可用' : ''}
                </option>
              ))
              : FALLBACK_ENGINES.map((id) => (
                <option key={id} value={id}>{id}</option>
              ))}
          </select>

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
                前往引擎设置安装 →
              </button>
            </div>
          )}

          {!hasAvailableEngine && engineOptions.length > 0 && (
            <p style={{ color: '#fab387', fontSize: 12, margin: '4px 0 0' }}>
              当前没有可用引擎。请先在「设置 → 引擎管理」中安装并启用至少一个引擎。
            </p>
          )}

          <label style={lbl}>Working Directory <span style={req}>*</span></label>
          <input style={inp} value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/path/to/instance" required />

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
                可选。通常在「设置 → 全局」配置共享 channel 即可让所有 agent 外网可达，无需在此填写。
                仅当该 agent 需要独立的 channel（例如用不同的 channel 服务、或未启用全局路由器）时才在此配置。
                三项须同时填写；Base URL 留空时会自动由 Server URL + Channel ID 推导。
              </p>
              <label style={lbl}>
                Server URL
                {hubMeta?.lastTunnelServerUrl && tunnelServer === hubMeta.lastTunnelServerUrl && (
                  <span style={reuseTag}> reused from last session</span>
                )}
              </label>
              <input
                style={inp}
                value={tunnelServer}
                onChange={(e) => setTunnelServer(e.target.value)}
                placeholder="https://channel.example.com"
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
const reuseTag: React.CSSProperties = {
  color: '#a6e3a1', fontSize: 11, fontStyle: 'italic',
};
const unavailableBox: React.CSSProperties = {
  background: '#45263233', border: '1px solid #f38ba866', borderRadius: 6,
  padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8,
};
const installLinkBtn: React.CSSProperties = {
  alignSelf: 'flex-start', background: 'transparent', border: '1px solid #89b4fa',
  color: '#89b4fa', borderRadius: 5, padding: '5px 12px', cursor: 'pointer', fontSize: 13,
};
