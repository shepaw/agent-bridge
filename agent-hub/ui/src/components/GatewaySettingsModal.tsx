import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import type { GatewayInfo } from '../api/types.js';
import { useI18n } from '../i18n/index.js';

/**
 * Shared Channel Service tunnel + tunnel router controls. Used on the Peer
 * pairing tab so remote phones can reach `/peer/ws` via the channel.
 */
export function ChannelSettingsPanel() {
  const { t } = useI18n();
  const [info, setInfo] = useState<GatewayInfo | null>(null);
  const [serverUrl, setServerUrl] = useState('');
  const [channelId, setChannelId] = useState('');
  const [secret, setSecret] = useState('');
  const [routerPort, setRouterPort] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    try {
      const g = await api.gateway.get();
      setInfo(g);
      setServerUrl(g.channel?.serverUrl ?? '');
      setChannelId(g.channel?.channelId ?? '');
      setRouterPort(String(g.routerPort));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const saveChannel = async () => {
    setBusy(true); setErr(null); setNotice(null);
    try {
      if (!serverUrl.trim() || !channelId.trim() || !secret.trim()) {
        throw new Error(t('gateway.required'));
      }
      await api.gateway.setChannel({
        serverUrl: serverUrl.trim(),
        channelId: channelId.trim(),
        secret: secret.trim(),
        routerPort: routerPort.trim() ? Number(routerPort) : undefined,
      });
      setSecret('');
      const wasRunning = info?.status.running === true;
      if (!wasRunning) {
        try {
          await api.gateway.start();
          setNotice(t('gateway.savedStarted'));
        } catch (startErr) {
          setNotice(
            t('gateway.savedStartFail', {
              error: startErr instanceof Error ? startErr.message : String(startErr),
            }),
          );
        }
      } else {
        setNotice(t('gateway.savedRestart'));
      }
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const clearChannel = async () => {
    setBusy(true); setErr(null); setNotice(null);
    try {
      await api.gateway.clearChannel();
      setSecret('');
      setNotice(t('gateway.removed'));
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const startRouter = async () => {
    setBusy(true); setErr(null); setNotice(null);
    try {
      await api.gateway.start();
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const stopRouter = async () => {
    setBusy(true); setErr(null); setNotice(null);
    try {
      await api.gateway.stop();
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const running = info?.status.running ?? false;

  return (
    <>
      <div style={statusRow}>
        <div>
          <span style={statusDot(running)} />
          <strong style={{ color: '#cdd6f4' }}>
            {running
              ? t('gateway.routerRunning', { pid: info?.status.pid ?? '' })
              : t('gateway.routerStopped')}
          </strong>
          {info && (
            <span style={{ color: '#6c7086', fontSize: 12, marginLeft: 8 }}>
              {t('peer.port', { port: info.status.routerPort })}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {running ? (
            <button style={dangerBtn} disabled={busy} onClick={() => void stopRouter()}>{t('common.stop')}</button>
          ) : (
            <button style={primaryBtn} disabled={busy} onClick={() => void startRouter()}>{t('common.start')}</button>
          )}
        </div>
      </div>

      <p style={channelHint}>
        {t('gateway.hint')}
      </p>

      <label style={labelStyle}>{t('gateway.channelServiceUrl')}</label>
      <input style={input} value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="https://channel.example.com" />
      <label style={labelStyle}>{t('gateway.channelId')}</label>
      <input style={input} value={channelId} onChange={(e) => setChannelId(e.target.value)} placeholder="ch_abc123" />
      <label style={labelStyle}>{t('gateway.secret')}{info?.channel?.secretSet ? t('gateway.secretSet') : ''}</label>
      <input style={input} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={info?.channel?.secretSet ? '••••••••' : t('gateway.secretPlaceholder')} />
      <label style={labelStyle}>{t('gateway.localPort')}</label>
      <input style={input} value={routerPort} onChange={(e) => setRouterPort(e.target.value)} placeholder="18789" />
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button style={primaryBtn} disabled={busy} onClick={() => void saveChannel()}>{t('gateway.save')}</button>
        {info?.channel && (
          <button style={secondaryBtn} disabled={busy} onClick={() => void clearChannel()}>{t('gateway.remove')}</button>
        )}
      </div>

      {notice && <p style={{ color: '#a6e3a1', fontSize: 13, marginTop: 10 }}>{notice}</p>}
      {err && <p style={{ color: '#f38ba8', fontSize: 13, marginTop: 10 }}>{err}</p>}
    </>
  );
}

/** Combined panel for legacy modal callers. */
export function GatewaySettingsPanel() {
  return <ChannelSettingsPanel />;
}

/** Modal wrapper retained for any legacy callers. */
export function GatewaySettingsModal({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  return (
    <div style={overlay} onClick={onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={modalHeader}>
          <div>
            <h3 style={{ margin: 0, color: '#cdd6f4' }}>{t('gateway.modalTitle')}</h3>
            <p style={{ margin: '6px 0 0', color: '#a6adc8', fontSize: 13 }}>
              {t('gateway.modalHint')}
            </p>
          </div>
          <button style={closeBtn} onClick={onClose}>×</button>
        </div>
        <GatewaySettingsPanel />
      </div>
    </div>
  );
}

function statusDot(running: boolean): React.CSSProperties {
  return {
    display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
    background: running ? '#a6e3a1' : '#6c7086', marginRight: 8, verticalAlign: 'middle',
  };
}

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
};
const modal: React.CSSProperties = {
  background: '#1e1e2e', border: '1px solid #313244', borderRadius: 10,
  padding: '20px 24px', width: 'min(520px, 92vw)', maxHeight: '90vh', overflow: 'auto',
};
const modalHeader: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16,
};
const closeBtn: React.CSSProperties = {
  background: 'none', border: 'none', color: '#a6adc8', fontSize: 22, cursor: 'pointer',
};
const statusRow: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  background: '#181825', border: '1px solid #313244', borderRadius: 6, padding: '10px 12px',
  marginBottom: 12,
};
const channelHint: React.CSSProperties = { color: '#6c7086', fontSize: 12, margin: '0 0 12px' };
const labelStyle: React.CSSProperties = { display: 'block', color: '#a6adc8', fontSize: 13, margin: '10px 0 6px' };
const input: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '8px 10px',
  background: '#181825', border: '1px solid #313244', borderRadius: 6, color: '#cdd6f4',
};
const primaryBtn: React.CSSProperties = {
  background: '#89b4fa', color: '#1e1e2e', border: 'none', borderRadius: 6,
  padding: '8px 16px', cursor: 'pointer', fontWeight: 600,
};
const secondaryBtn: React.CSSProperties = {
  background: 'transparent', color: '#cdd6f4', border: '1px solid #45475a',
  borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontWeight: 600,
};
const dangerBtn: React.CSSProperties = {
  background: '#452632', color: '#f38ba8', border: '1px solid #f38ba8',
  borderRadius: 5, padding: '6px 14px', cursor: 'pointer', fontSize: 13,
};
