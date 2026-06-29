import { useState, useEffect } from 'react';
import { api } from '../api/client.js';
import type { AgentEngine, HubMeta } from '../api/types.js';

// Engine-specific credential field definitions (mirrors ProjectDetail)
interface CredField {
  key: string;
  label: string;
  type: 'password' | 'text';
  required?: boolean;
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
  tclaude: [
    { key: 'ANTHROPIC_API_KEY', label: 'API Key', type: 'password' },
    { key: 'ANTHROPIC_AUTH_TOKEN', label: 'Auth Token (alternative)', type: 'password' },
    { key: 'ANTHROPIC_BASE_URL', label: 'Base URL (custom endpoint)', type: 'text' },
  ],
  'codex': [
    { key: 'OPENAI_API_KEY', label: 'API Key', type: 'password' },
    { key: 'OPENAI_BASE_URL', label: 'Base URL (custom endpoint)', type: 'text' },
  ],
  tcodex: [
    { key: 'OPENAI_API_KEY', label: 'API Key', type: 'password' },
    { key: 'OPENAI_BASE_URL', label: 'Base URL (custom endpoint)', type: 'text' },
  ],
  'opencode': [],
  'openclaw': [],
  'cursor': [],
  'hermes': [],
};

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

  // Credentials (per engine key)
  const [credValues, setCredValues] = useState<Record<string, string>>({});
  // Credential hint display (masked): '' means no hint, non-empty shows the cached mask
  const [credHints, setCredHints] = useState<Record<string, string>>({});
  // Whether credential field is in "use cached" mode (showing hint, not entering new value)
  const [credUsingCache, setCredUsingCache] = useState<Record<string, boolean>>({});

  // Tunnel fields
  const [tunnelServer, setTunnelServer] = useState('');
  const [tunnelChannelId, setTunnelChannelId] = useState('');
  const [tunnelSecret, setTunnelSecret] = useState('');
  const [showTunnel, setShowTunnel] = useState(false);

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hubMeta, setHubMeta] = useState<HubMeta | null>(null);

  // Load hub metadata once for pre-filling hints
  useEffect(() => {
    api.projects.meta().then((meta) => {
      setHubMeta(meta);
      if (meta.lastTunnelServerUrl) {
        setTunnelServer(meta.lastTunnelServerUrl);
      }
    }).catch(() => { /* ignore — hub meta is optional UX enhancement */ });
  }, []);

  // When engine changes, update credential hints for the new engine
  useEffect(() => {
    if (!hubMeta) return;
    const hints = hubMeta.credentialHints[engine] ?? {};
    setCredHints(hints);
    // Pre-select "use cached" for keys that have hints, clear the input value
    const usingCache: Record<string, boolean> = {};
    const values: Record<string, string> = {};
    for (const field of ENGINE_CREDS[engine]) {
      if (hints[field.key]) {
        usingCache[field.key] = true;
        values[field.key] = ''; // empty = will use cached (sent as undefined to API)
      } else {
        usingCache[field.key] = false;
        values[field.key] = '';
      }
    }
    setCredUsingCache(usingCache);
    setCredValues(values);
  }, [engine, hubMeta]);

  const handleCredChange = (key: string, value: string) => {
    // Once user types, they are no longer using the cache for this field
    setCredUsingCache((prev) => ({ ...prev, [key]: false }));
    setCredValues((prev) => ({ ...prev, [key]: value }));
  };

  const toggleCacheForKey = (key: string) => {
    const nowUsingCache = !credUsingCache[key];
    setCredUsingCache((prev) => ({ ...prev, [key]: nowUsingCache }));
    if (nowUsingCache) {
      // Clear typed value when switching back to cached
      setCredValues((prev) => ({ ...prev, [key]: '' }));
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErr(null);
    try {
      // Treat '__use_cache__' sentinel as empty (secret hint is display-only)
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

      // Auto-derive baseUrl from tunnel if not explicitly set
      const resolvedBaseUrl = baseUrl || (tunnel ? `${tunnel.serverUrl}/proxy/${tunnel.channelId}` : '');

      // Build envVars: only include keys with an explicit new value (not "using cache").
      // Keys in "use cache" mode are omitted — the backend will auto-fill them from
      // the hub-level credentialHints store.
      const envVars: Record<string, string> = {};
      for (const field of ENGINE_CREDS[engine]) {
        const val = credValues[field.key] ?? '';
        if (!credUsingCache[field.key] && val.length > 0) {
          envVars[field.key] = val;
        }
      }

      await api.projects.create({
        id,
        label: label || id,
        engine,
        cwd,
        host,
        baseUrl: resolvedBaseUrl,
        tunnel,
        envVars: Object.keys(envVars).length > 0 ? envVars : undefined,
      });
      onCreated();
      onClose();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setLoading(false);
    }
  };

  const credFields = ENGINE_CREDS[engine];

  return (
    <div style={overlay}>
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
            <option value="tclaude">tclaude</option>
            <option value="codex">codex</option>
            <option value="tcodex">tcodex</option>
            <option value="opencode">opencode</option>
            <option value="openclaw">openclaw</option>
            <option value="cursor">cursor</option>
            <option value="hermes">hermes</option>
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

          {/* Credentials section */}
          {credFields.length > 0 && (
            <>
              <div style={sectionDivider} />
              <p style={sectionTitle}>Credentials</p>
              {credFields.map((field) => {
                const hint = credHints[field.key];
                const usingCache = credUsingCache[field.key];
                return (
                  <div key={field.key}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <label style={lbl}>
                        {field.label}
                        {field.required && <span style={req}> *</span>}
                      </label>
                      {hint && (
                        <button
                          type="button"
                          style={hintToggleBtn}
                          onClick={() => toggleCacheForKey(field.key)}
                          title={usingCache ? 'Click to enter a different key' : `Click to use cached: ${hint}`}
                        >
                          {usingCache ? `Using: ${hint}` : `Cached: ${hint}`}
                        </button>
                      )}
                    </div>
                    {!usingCache && (
                      <input
                        style={inp}
                        type={field.type}
                        value={credValues[field.key] ?? ''}
                        onChange={(e) => handleCredChange(field.key, e.target.value)}
                        placeholder={hint ? 'Enter new value to override cached key' : `Enter ${field.label}`}
                        required={field.required && !hint}
                      />
                    )}
                    {usingCache && hint && (
                      <div style={cachedValueDisplay}>
                        <span style={{ color: '#a6e3a1', fontSize: 13 }}>{hint}</span>
                        <span style={{ color: '#6c7086', fontSize: 12, marginLeft: 8 }}>(cached — click above to change)</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}

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
const sectionDivider: React.CSSProperties = {
  borderTop: '1px solid #313244', marginTop: 4, marginBottom: 2,
};
const sectionTitle: React.CSSProperties = {
  color: '#a6adc8', fontSize: 12, fontWeight: 600, margin: '0 0 2px',
  textTransform: 'uppercase', letterSpacing: '0.05em',
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
