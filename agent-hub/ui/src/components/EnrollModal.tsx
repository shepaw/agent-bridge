import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { api } from '../api/client.js';
import type { EnrollToken } from '../api/types.js';

interface EnrollModalProps {
  instanceId: string;
  onClose: () => void;
  baseUrl?: string;
}

export function EnrollModal({ instanceId, onClose, baseUrl: initialBaseUrl }: EnrollModalProps) {
  const [token, setToken] = useState<EnrollToken | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tunnelUrl, setTunnelUrl] = useState(initialBaseUrl ?? '');
  const [label, setLabel] = useState('');

  const mint = async () => {
    setLoading(true);
    setErr(null);
    try {
      const t = await api.enroll.mint(instanceId, {
        ttlMinutes: 10,
        label: label || undefined,
        baseUrl: tunnelUrl || undefined,
      });
      setToken(t);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={overlay}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={modalHeader}>
          <h3 style={{ margin: 0, color: '#cdd6f4' }}>Pair device — {instanceId}</h3>
          <button style={closeBtn} onClick={onClose}>✕</button>
        </div>

        {!token && (
          <div style={{ padding: 20 }}>
            <p style={{ color: '#a6adc8', margin: '0 0 16px' }}>
              Generate a single-use pairing code for the Shepaw mobile app.
              The code expires after 10 minutes.
            </p>

            <div style={formGroup}>
              <label style={label2}>Device Label (optional)</label>
              <input
                style={inp2}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="My iPhone"
              />
            </div>

            <div style={formGroup}>
              <label style={label2}>
                Tunnel URL (optional)
                <span style={{ color: '#a6adc8', fontSize: 12, marginLeft: 8 }}>
                  Use if connecting via tunnel/proxy
                </span>
              </label>
              <input
                style={inp2}
                value={tunnelUrl}
                onChange={(e) => setTunnelUrl(e.target.value)}
                placeholder="wss://proxy.example.com"
              />
            </div>

            {err && <p style={{ color: '#f38ba8' }}>{err}</p>}
            <button style={mintBtn} disabled={loading} onClick={() => void mint()}>
              {loading ? 'Generating...' : 'Generate Pairing Code'}
            </button>
          </div>
        )}

        {token && (
          <div style={tokenBody}>
            {token.qrPayload && (
              <div style={qrWrap}>
                <QRCodeSVG
                  value={token.qrPayload}
                  size={200}
                  bgColor="#1e1e2e"
                  fgColor="#cdd6f4"
                  level="M"
                />
              </div>
            )}

            <div style={tokenInfo}>
              <p style={infoRow}>
                <span style={infoLabel}>Code</span>
                <code style={codeBox}>{token.display ?? token.code}</code>
              </p>
              <p style={infoRow}>
                <span style={infoLabel}>Expires</span>
                <span>{new Date(token.expiresAt).toLocaleString()}</span>
              </p>
              {token.pairUrl && (
                <p style={infoRow}>
                  <span style={infoLabel}>URL</span>
                  <code style={{ ...codeBox, fontSize: 11, wordBreak: 'break-all' }}>{token.pairUrl}</code>
                </p>
              )}
              <p style={{ color: '#a6adc8', fontSize: 12, marginTop: 12 }}>
                Scan the QR code in the Shepaw app, or enter the code + URL manually.
                The code is invalidated after the first successful handshake.
              </p>
            </div>

            <button style={{ ...mintBtn, marginTop: 16 }} onClick={() => void (setToken(null))}>
              Generate Another
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0,
  background: 'rgba(0,0,0,0.6)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 100,
};

const modal: React.CSSProperties = {
  background: '#1e1e2e',
  border: '1px solid #45475a',
  borderRadius: 10,
  width: '90%',
  maxWidth: 520,
  maxHeight: '90vh',
  overflow: 'auto',
};

const modalHeader: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '14px 20px',
  borderBottom: '1px solid #313244',
};

const closeBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#a6adc8',
  fontSize: 18,
  cursor: 'pointer',
};

const mintBtn: React.CSSProperties = {
  background: '#cba6f7',
  color: '#11111b',
  border: 'none',
  borderRadius: 6,
  padding: '8px 20px',
  cursor: 'pointer',
  fontWeight: 600,
};

const tokenBody: React.CSSProperties = {
  padding: 20,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
};

const qrWrap: React.CSSProperties = {
  padding: 16,
  background: '#11111b',
  borderRadius: 8,
  marginBottom: 16,
};

const tokenInfo: React.CSSProperties = {
  width: '100%',
};

const infoRow: React.CSSProperties = {
  margin: '8px 0',
  display: 'flex',
  gap: 12,
  alignItems: 'flex-start',
  color: '#cdd6f4',
  fontSize: 14,
};

const infoLabel: React.CSSProperties = {
  color: '#a6adc8',
  minWidth: 70,
  fontWeight: 500,
};

const codeBox: React.CSSProperties = {
  background: '#313244',
  padding: '2px 8px',
  borderRadius: 4,
  fontSize: 14,
  letterSpacing: 2,
};

const formGroup: React.CSSProperties = {
  marginBottom: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const label2: React.CSSProperties = {
  color: '#a6adc8',
  fontSize: 13,
  display: 'flex',
  alignItems: 'center',
};

const inp2: React.CSSProperties = {
  background: '#313244',
  border: '1px solid #45475a',
  borderRadius: 4,
  color: '#cdd6f4',
  padding: '6px 10px',
  fontSize: 13,
  outline: 'none',
};
