import { useEffect, useState } from 'react';
import {
  fetchHubAuthRequired,
  getHubAuthToken,
  setHubAuthToken,
  stripHubAuthTokenFromUrl,
  verifyHubAuthToken,
} from '../api/client.js';
import { HubAuthTokenPanel } from './HubAuthTokenPanel.js';
import { LanguageSwitcher } from './LanguageSwitcher.js';
import { useI18n } from '../i18n/index.js';

type GatePhase = 'checking' | 'blocked' | 'ready';

/**
 * Blocks the dashboard until the user supplies a valid SHEPAW_HUB_TOKEN when
 * the server requires auth. Avoids bootstrapping secrets from URL query params.
 */
export function HubAuthGate({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
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
        <div style={{ position: 'absolute', top: 20, right: 20 }}>
          <LanguageSwitcher />
        </div>
        <p style={{ margin: 0, color: '#a6adc8', fontSize: 14 }}>{t('auth.connecting')}</p>
      </div>
    );
  }

  if (phase === 'blocked') {
    return (
      <div style={splash}>
        <div style={{ position: 'absolute', top: 20, right: 20 }}>
          <LanguageSwitcher />
        </div>
        <div
          style={modal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="hub-auth-gate-title"
        >
          <h2 id="hub-auth-gate-title" style={title}>
            {t('auth.gateTitle')}
          </h2>
          <p style={hint}>
            {t('auth.gateEnabled')}
            {invalidExisting ? t('auth.gateInvalid') : t('auth.gateEnter')}
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
  position: 'relative',
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
