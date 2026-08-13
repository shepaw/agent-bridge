import { useEffect, useState } from 'react';
import {
  fetchHubAuthRequired,
  getHubAuthToken,
  setHubAuthToken,
  stripHubAuthTokenFromUrl,
  verifyHubAuthToken,
} from '../api/client.js';
import { HubAuthTokenPanel } from './HubAuthTokenPanel.js';

type GatePhase = 'checking' | 'blocked' | 'ready';

/**
 * Blocks the dashboard until the user supplies a valid SHEPAW_HUB_TOKEN when
 * the server requires auth. Avoids bootstrapping secrets from URL query params.
 */
export function HubAuthGate({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<GatePhase>('checking');
  const [invalidExisting, setInvalidExisting] = useState(false);

  const runCheck = async () => {
    stripHubAuthTokenFromUrl();
    try {
      const required = await fetchHubAuthRequired();
      if (!required) {
        setPhase('ready');
        return;
      }
      const token = getHubAuthToken();
      if (!token) {
        setInvalidExisting(false);
        setPhase('blocked');
        return;
      }
      const result = await verifyHubAuthToken(token);
      if (result.ok) {
        setInvalidExisting(false);
        setPhase('ready');
        return;
      }
      setHubAuthToken(null);
      setInvalidExisting(true);
      setPhase('blocked');
    } catch {
      // Offline / dev proxy glitch — let the app surface errors normally.
      setPhase('ready');
    }
  };

  useEffect(() => {
    void runCheck();
  }, []);

  if (phase === 'checking') {
    return (
      <div style={splash}>
        <p style={{ margin: 0, color: '#a6adc8', fontSize: 14 }}>正在连接 Hub…</p>
      </div>
    );
  }

  if (phase === 'blocked') {
    return (
      <div style={splash}>
        <div
          style={modal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="hub-auth-gate-title"
        >
          <h2 id="hub-auth-gate-title" style={title}>
            Dashboard 鉴权
          </h2>
          <p style={hint}>
            服务端已启用 <code style={code}>SHEPAW_HUB_TOKEN</code>。
            {invalidExisting
              ? ' 本机保存的 Token 无效，请重新输入。'
              : ' 请输入与启动 Hub 时相同的 Token 以继续。'}
          </p>
          <HubAuthTokenPanel
            onSaved={() => {
              setInvalidExisting(false);
              setPhase('ready');
            }}
          />
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

const splash: React.CSSProperties = {
  minHeight: '100vh',
  background: '#11111b',
  color: '#cdd6f4',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  padding: 20,
};

const modal: React.CSSProperties = {
  background: '#1e1e2e',
  border: '1px solid #45475a',
  borderRadius: 10,
  width: '100%',
  maxWidth: 480,
  padding: '24px 28px',
  boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
};

const title: React.CSSProperties = {
  margin: '0 0 10px',
  fontSize: 18,
  fontWeight: 700,
  color: '#cdd6f4',
};

const hint: React.CSSProperties = {
  margin: '0 0 16px',
  color: '#a6adc8',
  fontSize: 14,
  lineHeight: 1.55,
};

const code: React.CSSProperties = {
  background: '#181825',
  border: '1px solid #313244',
  borderRadius: 4,
  padding: '0 4px',
  fontSize: 13,
};
