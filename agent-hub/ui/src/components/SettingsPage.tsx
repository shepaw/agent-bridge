import { DeviceNamePanel } from './DeviceNamePanel.js';
import { HubAuthTokenPanel } from './HubAuthTokenPanel.js';
import { PeerPairingPanel } from './PeerPairingPanel.js';
import { VersionPanel } from './VersionPanel.js';
import type { SettingsTab } from '../utils/settingsRoute.js';
import { useI18n } from '../i18n/index.js';

/**
 * Settings content panels (nav lives in App shell).
 *   - 全局: dashboard auth token + device name
 *   - 扫码配对: peer service + shepaw://peer QR + shared Channel
 *
 * Per-engine configuration moved to the per-engine page (#engine/<id>), so the
 * engine management section no longer lives here.
 */

export function SettingsPage({
  tab,
  onAuthTokenSaved,
}: {
  tab: SettingsTab;
  onAuthTokenSaved?: () => void;
}) {
  const { t } = useI18n();
  return (
    <>
      {tab === 'global' && (
        <div style={panel}>
          <section style={card}>
            <h3 style={cardTitle}>{t('settings.tokenTitle')}</h3>
            <p style={cardHint}>{t('settings.tokenHint')}</p>
            <HubAuthTokenPanel onSaved={onAuthTokenSaved} />
          </section>
          <section style={card}>
            <h3 style={cardTitle}>{t('settings.deviceNameTitle')}</h3>
            <p style={cardHint}>{t('settings.deviceNameHint')}</p>
            <DeviceNamePanel />
          </section>
          <VersionPanel />
        </div>
      )}

      {tab === 'peer' && (
        <section style={card}>
          <h3 style={cardTitle}>{t('settings.peerTitle')}</h3>
          <p style={cardHint}>{t('settings.peerHint')}</p>
          <PeerPairingPanel />
        </section>
      )}
    </>
  );
}

const panel: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 16 };
const card: React.CSSProperties = {
  background: '#1e1e2e', border: '1px solid #313244', borderRadius: 10, padding: '20px 24px',
};
const cardTitle: React.CSSProperties = { margin: '0 0 4px', color: '#cdd6f4', fontSize: 16 };
const cardHint: React.CSSProperties = { margin: '0 0 16px', color: '#a6adc8', fontSize: 13 };
