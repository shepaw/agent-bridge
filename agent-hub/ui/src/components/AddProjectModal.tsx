import { useState } from 'react';
import { api } from '../api/client.js';
import type { AgentEngine } from '../api/types.js';

interface AddProjectModalProps {
  onClose: () => void;
  onCreated: () => void;
}

export function AddProjectModal({ onClose, onCreated }: AddProjectModalProps) {
  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [engine, setEngine] = useState<AgentEngine>('codebuddy');
  const [cwd, setCwd] = useState('');
  const [host, setHost] = useState('127.0.0.1');
  const [baseUrl, setBaseUrl] = useState('');
  // Tunnel fields
  const [tunnelServer, setTunnelServer] = useState('');
  const [tunnelChannelId, setTunnelChannelId] = useState('');
  const [tunnelSecret, setTunnelSecret] = useState('');
  const [showTunnel, setShowTunnel] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErr(null);
    try {
      const hasTunnel = tunnelServer && tunnelChannelId && tunnelSecret;
      if ((tunnelServer || tunnelChannelId || tunnelSecret) && !hasTunnel) {
        setErr('All three tunnel fields (server, channel ID, secret) are required together.');
        setLoading(false);
        return;
      }
      const tunnel = hasTunnel
        ? { serverUrl: tunnelServer, channelId: tunnelChannelId, secret: tunnelSecret }
        : undefined;
      // Auto-derive baseUrl from tunnel if not explicitly set
      const resolvedBaseUrl = baseUrl || (tunnel ? `${tunnel.serverUrl}/proxy/${tunnel.channelId}` : '');
      await api.projects.create({ id, label: label || id, engine, cwd, host, baseUrl: resolvedBaseUrl, tunnel });
      onCreated();
      onClose();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <h3 style={{ margin: 0, color: '#cdd6f4' }}>Add Project</h3>
          <button style={closeBtn} onClick={onClose}>✕</button>
        </div>

        <form onSubmit={(e) => void submit(e)} style={form}>
          <label style={lbl}>ID <span style={req}>*</span></label>
          <input style={inp} value={id} onChange={(e) => setId(e.target.value)} placeholder="my-project" required />

          <label style={lbl}>Label</label>
          <input style={inp} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="My Project" />

          <label style={lbl}>Engine <span style={req}>*</span></label>
          <select style={inp} value={engine} onChange={(e) => setEngine(e.target.value as AgentEngine)}>
            <option value="codebuddy">codebuddy</option>
            <option value="claude-code">claude-code</option>
            <option value="codex">codex</option>
            <option value="opencode">opencode</option>
          </select>

          <label style={lbl}>Working Directory <span style={req}>*</span></label>
          <input style={inp} value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/path/to/project" required />

          <label style={lbl}>Bind Host</label>
          <select style={inp} value={host} onChange={(e) => setHost(e.target.value)}>
            <option value="127.0.0.1">127.0.0.1 (loopback only)</option>
            <option value="0.0.0.0">0.0.0.0 (all interfaces)</option>
          </select>

          <label style={lbl}>Base URL <span style={{ color: '#6c7086', fontSize: 11 }}>(optional — auto-derived from tunnel)</span></label>
          <input style={inp} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="wss://example.com (leave blank if using tunnel)" />

          {/* Tunnel section */}
          <button
            type="button"
            style={tunnelToggle}
            onClick={() => setShowTunnel((v) => !v)}
          >
            {showTunnel ? '▼' : '▶'} Tunnel Configuration (Shepaw Channel Service)
          </button>

          {showTunnel && (
            <div style={tunnelBox}>
              <p style={tunnelNote}>
                Configure a Shepaw Channel Service tunnel so the agent is reachable remotely.
                All three fields are required together. The Base URL above will be auto-derived
                from Server URL + Channel ID if left blank.
              </p>
              <label style={lbl}>Server URL</label>
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
              <label style={lbl}>Secret</label>
              <input
                style={inp}
                type="password"
                value={tunnelSecret}
                onChange={(e) => setTunnelSecret(e.target.value)}
                placeholder="HMAC-SHA256 signing secret"
              />
            </div>
          )}

          {err && <p style={{ color: '#f38ba8', margin: '4px 0' }}>{err}</p>}

          <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
            <button type="submit" style={submitBtn} disabled={loading}>
              {loading ? 'Creating...' : 'Create Project'}
            </button>
            <button type="button" style={cancelBtn} onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────────

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0,
  background: 'rgba(0,0,0,0.6)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 100,
};
const modal: React.CSSProperties = {
  background: '#1e1e2e', border: '1px solid #45475a',
  borderRadius: 10, width: '90%', maxWidth: 460,
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
