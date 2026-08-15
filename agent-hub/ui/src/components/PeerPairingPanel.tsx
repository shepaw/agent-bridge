import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { api } from '../api/client.js';
import type { GatewayInfo, PairedPeer, PeerPairingResult, PeerServiceStatus } from '../api/types.js';
import { useI18n } from '../i18n/index.js';
import { ChannelSettingsPanel } from './GatewaySettingsModal.js';
import { HubAuthTokenPanel } from './HubAuthTokenPanel.js';
import { GATEWAY_PAIRING_UI } from '../utils/featureFlags.js';

/**
 * Scan-to-pair panel: Peer is started by `shepaw-hub web` (and again here
 * if needed). Auto-mint `shepaw://peer` QR, then optional Channel + devices.
 */
export function PeerPairingPanel() {
  const { t } = useI18n();
  const [status, setStatus] = useState<PeerServiceStatus | null>(null);
  const [devices, setDevices] = useState<PairedPeer[]>([]);
  const [pairing, setPairing] = useState<PeerPairingResult | null>(null);
  const [gateway, setGateway] = useState<GatewayInfo | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [booting, setBooting] = useState(true);
  const [channelExpanded, setChannelExpanded] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoQrDone = useRef(false);

  const load = async () => {
    const peerRes = await api.peer.get();
    setStatus(peerRes.status);
    setDevices(peerRes.devices);
    if (GATEWAY_PAIRING_UI) {
      const gw = await api.gateway.get();
      setGateway(gw);
      return { peerStatus: peerRes.status, gateway: gw };
    }
    return { peerStatus: peerRes.status, gateway: null as GatewayInfo | null };
  };

  // On open: ensure Peer is running, then mint QR so the app can scan immediately.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setBooting(true);
      setErr(null);
      try {
        let { peerStatus, gateway: gw } = await load();
        if (cancelled) return;
        if (!peerStatus.running) {
          await api.peer.start();
          if (cancelled) return;
          ({ peerStatus, gateway: gw } = await load());
        }
        if (cancelled) return;
        if (GATEWAY_PAIRING_UI && gw?.channel && !gw.status.running) {
          try {
            await api.gateway.start();
            if (cancelled) return;
            ({ peerStatus, gateway: gw } = await load());
          } catch {
            /* channel misconfigured — pairing tab still works on LAN */
          }
        }
        if (cancelled) return;
        if (peerStatus.running && !autoQrDone.current) {
          autoQrDone.current = true;
          setPairing(await api.peer.pair());
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!pairing) { setSecondsLeft(0); return; }
    const tick = () => {
      const left = Math.max(0, Math.floor((pairing.expiresAt - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left === 0) setPairing(null);
    };
    tick();
    timerRef.current = setInterval(tick, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [pairing]);

  // Already configured — keep the section open so operators can manage it.
  useEffect(() => {
    if (GATEWAY_PAIRING_UI && gateway?.channel) setChannelExpanded(true);
  }, [gateway?.channel]);

  const start = async () => {
    setBusy(true); setErr(null);
    try {
      await api.peer.start();
      await load();
      if (!pairing) setPairing(await api.peer.pair());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    setBusy(true); setErr(null);
    try {
      await api.peer.stop();
      setPairing(null);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const mint = async () => {
    setBusy(true); setErr(null);
    try { setPairing(await api.peer.pair()); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const revoke = async (fp: string) => {
    setBusy(true); setErr(null);
    try { await api.peer.removeDevice(fp); await load(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  const running = status?.running ?? false;

  return (
    <>
      {err && /unauthorized|SHEPAW_HUB_TOKEN/i.test(err) && (
        <div style={authBox}>
          <p style={{ margin: '0 0 12px', color: '#f9e2af', fontSize: 13 }}>
            {t('peer.authFail')}
          </p>
          <HubAuthTokenPanel
            onSaved={() => {
              setErr(null);
              autoQrDone.current = false;
              void load().then(async ({ peerStatus }) => {
                if (!peerStatus.running) {
                  await api.peer.start();
                  ({ peerStatus } = await load());
                }
                if (peerStatus.running) {
                  autoQrDone.current = true;
                  setPairing(await api.peer.pair());
                }
              }).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
            }}
          />
        </div>
      )}

      <div style={sectionFirst}>
        <h4 style={sectionTitle}>{t('peer.section')}</h4>
        <p style={priorityHint}>
          {t('peer.hint')}
        </p>
        {GATEWAY_PAIRING_UI && gateway?.channel && !gateway.status.running && (
          <p style={warn}>
            {t('peer.channelWarn')}
          </p>
        )}
        <div style={statusRow}>
          <div>
            <span style={dot(running)} />
            <strong style={{ color: '#cdd6f4' }}>
              {booting && !status
                ? t('peer.statusBooting')
                : running
                  ? t('peer.statusRunning', { pid: status?.pid ?? '' })
                  : t('peer.statusStopped')}
            </strong>
            {status && <span style={{ color: '#6c7086', fontSize: 12, marginLeft: 8 }}>{t('peer.port', { port: status.port })}</span>}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {running
              ? <button style={dangerBtn} disabled={busy || booting} onClick={() => void stop()}>{t('common.stop')}</button>
              : <button style={primaryBtn} disabled={busy || booting} onClick={() => void start()}>{t('common.start')}</button>}
          </div>
        </div>
        <p style={hint}>
          {t('peer.scanHint')}
          {GATEWAY_PAIRING_UI && gateway?.channel ? t('peer.qrBoth') : t('peer.qrLanOnly')}
        </p>

        {booting && !pairing ? (
          <p style={{ color: '#a6adc8', fontSize: 13, margin: '0 0 8px' }}>{t('peer.preparingQr')}</p>
        ) : !pairing ? (
          <button style={primaryBtn} disabled={busy || !running} onClick={() => void mint()}>
            {busy ? t('peer.minting') : t('peer.mint')}
          </button>
        ) : (
          <div style={qrBlock}>
            <QRCodeSVG value={pairing.qrPayload} size={200} bgColor="#1e1e2e" fgColor="#cdd6f4" />
            <p style={{ color: '#a6e3a1', fontSize: 24, letterSpacing: 6, margin: '12px 0 4px' }}>{pairing.code}</p>
            <p style={{ color: '#a6adc8', fontSize: 13, margin: 0 }}>
              {secondsLeft > 0 ? t('peer.expiresIn', { seconds: secondsLeft }) : t('peer.expired')}
            </p>
            <p style={{ color: '#6c7086', fontSize: 12, marginTop: 8 }}>
              {t('peer.lan', { endpoint: pairing.localEndpoint })}
              {GATEWAY_PAIRING_UI && pairing.channelEndpoint && (
                <>
                  <br />
                  {t('peer.channel', { endpoint: pairing.channelEndpoint })}
                </>
              )}
            </p>
            <div style={linkBox}>
              <div style={linkLabel}>{t('peer.linkLabel')}</div>
              <div style={linkRow}>
                <code style={linkCode} title={pairing.qrPayload}>{pairing.qrPayload}</code>
                <button
                  style={copyBtn}
                  onClick={() => { try { void navigator.clipboard.writeText(pairing.qrPayload); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ } }}
                >{copied ? t('common.copied') : t('common.copy')}</button>
              </div>
              <div style={linkHint}>
                {t('peer.emulatorHint')}
              </div>
            </div>
            <button
              type="button"
              style={{ ...secondaryBtn, marginTop: 12 }}
              disabled={busy || !running}
              onClick={() => void mint()}
            >
              {t('peer.refreshQr')}
            </button>
          </div>
        )}

        {err && !/unauthorized|SHEPAW_HUB_TOKEN/i.test(err) && (
          <p style={{ color: '#f38ba8', fontSize: 13 }}>{err}</p>
        )}
      </div>

      {GATEWAY_PAIRING_UI && (
      <div style={section}>
        <button
          type="button"
          style={collapseHeader}
          aria-expanded={channelExpanded}
          onClick={() => setChannelExpanded((v) => !v)}
        >
          <span style={collapseTitleRow}>
            <span style={chevron}>{channelExpanded ? '▾' : '▸'}</span>
            <span style={sectionTitleInline}>{t('peer.channelTitle')}</span>
            {gateway?.channel && !channelExpanded && (
              <span style={configuredBadge}>{t('common.configured')}</span>
            )}
          </span>
          <span style={collapseAction}>{channelExpanded ? t('common.collapse') : t('common.expand')}</span>
        </button>
        {!channelExpanded && (
          <p style={channelCollapsedHint}>
            {t('peer.channelCollapsed')}
          </p>
        )}
        {channelExpanded && <ChannelSettingsPanel />}
      </div>
      )}

      <div style={section}>
        <h4 style={sectionTitle}>{t('peer.devicesTitle', { count: devices.length })}</h4>
        {devices.length === 0
          ? <p style={hint}>{t('peer.noDevices')}</p>
          : devices.map((d) => (
            <div key={d.fingerprint} style={deviceRow}>
              <div>
                <strong style={{ color: '#cdd6f4' }}>{d.deviceName || d.fingerprint}</strong>
                <span style={{ color: '#6c7086', fontSize: 12, marginLeft: 8 }}>{d.fingerprint}</span>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  style={secondaryBtn}
                  type="button"
                  onClick={() => {
                    const uri = `store://files/${d.fingerprint}/`;
                    location.hash = `#store/${encodeURIComponent(uri)}`;
                  }}
                >
                  {t('peer.openStore')}
                </button>
                <button style={dangerBtn} disabled={busy} onClick={() => void revoke(d.fingerprint)}>{t('peer.revoke')}</button>
              </div>
            </div>
          ))}
      </div>
    </>
  );
}

function dot(running: boolean): React.CSSProperties {
  return { display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: running ? '#a6e3a1' : '#6c7086', marginRight: 8, verticalAlign: 'middle' };
}

const statusRow: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#181825', border: '1px solid #313244', borderRadius: 6, padding: '10px 12px', marginBottom: 12 };
const hint: React.CSSProperties = { color: '#6c7086', fontSize: 12, margin: '0 0 12px' };
const priorityHint: React.CSSProperties = { color: '#a6adc8', fontSize: 13, margin: '0 0 12px', lineHeight: 1.45 };
const warn: React.CSSProperties = { color: '#f9e2af', fontSize: 12, margin: '0 0 12px' };
const primaryBtn: React.CSSProperties = { background: '#89b4fa', color: '#1e1e2e', border: 'none', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontWeight: 600 };
const secondaryBtn: React.CSSProperties = { background: 'transparent', color: '#cdd6f4', border: '1px solid #45475a', borderRadius: 6, padding: '6px 14px', cursor: 'pointer', fontSize: 13 };
const dangerBtn: React.CSSProperties = { background: '#452632', color: '#f38ba8', border: '1px solid #f38ba8', borderRadius: 5, padding: '6px 12px', cursor: 'pointer', fontSize: 12 };
const qrBlock: React.CSSProperties = { textAlign: 'center', marginBottom: 16 };
const linkBox: React.CSSProperties = { marginTop: 14, padding: '10px 12px', background: '#11111b', border: '1px solid #313244', borderRadius: 6, textAlign: 'left' };
const linkLabel: React.CSSProperties = { color: '#a6adc8', fontSize: 12, marginBottom: 6 };
const linkRow: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'stretch' };
const linkCode: React.CSSProperties = { flex: 1, padding: '6px 8px', background: '#181825', border: '1px solid #313244', borderRadius: 4, color: '#89dceb', fontSize: 11, wordBreak: 'break-all', overflow: 'hidden' };
const copyBtn: React.CSSProperties = { background: '#313244', color: '#cdd6f4', border: '1px solid #45475a', borderRadius: 4, padding: '0 12px', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' };
const linkHint: React.CSSProperties = { color: '#6c7086', fontSize: 11, marginTop: 8, lineHeight: 1.5 };
const sectionFirst: React.CSSProperties = { marginTop: 0 };
const section: React.CSSProperties = { marginTop: 16, borderTop: '1px solid #313244', paddingTop: 14 };
const collapseHeader: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  width: '100%',
  padding: 0,
  margin: '0 0 10px',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  textAlign: 'left',
};
const collapseTitleRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
};
const chevron: React.CSSProperties = { color: '#89b4fa', fontSize: 14, lineHeight: 1 };
const sectionTitleInline: React.CSSProperties = { color: '#cdd6f4', fontSize: 14, fontWeight: 600 };
const configuredBadge: React.CSSProperties = {
  background: '#313244',
  color: '#a6e3a1',
  fontSize: 11,
  fontWeight: 600,
  borderRadius: 4,
  padding: '2px 6px',
  marginLeft: 4,
};
const collapseAction: React.CSSProperties = {
  color: '#6c7086',
  fontSize: 12,
  flexShrink: 0,
  marginLeft: 12,
};
const channelCollapsedHint: React.CSSProperties = {
  color: '#6c7086',
  fontSize: 12,
  margin: 0,
  lineHeight: 1.55,
};
const authBox: React.CSSProperties = {
  background: '#181825', border: '1px solid #f9e2af', borderRadius: 8,
  padding: '14px 16px', marginBottom: 8,
};
const sectionTitle: React.CSSProperties = { margin: '0 0 12px', color: '#cdd6f4', fontSize: 14 };
const deviceRow: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #313244' };
