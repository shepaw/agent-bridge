import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { api } from '../api/client.js';
import type { GatewayInfo, PairedPeer, PeerPairingResult, PeerServiceStatus } from '../api/types.js';
import { useI18n, type MessageKey } from '../i18n/index.js';
import { SHEPAW_APP_DOWNLOAD_URL } from '../utils/appLinks.js';
import { chat } from '../utils/chatTheme.js';
import { PublicChannelGuide, SelfHostChannelGuide } from './ConnectChannelGuide.js';
import { ChannelSettingsPanel } from './GatewaySettingsModal.js';
import { HubAuthTokenPanel } from './HubAuthTokenPanel.js';
import { IconPeer, IconStore } from './NavIcons.js';

type ExternalMethod = 'channel' | 'selfhost';

/**
 * Connect-client panel: Peer is started by `shepaw-hub web` (and again here if
 * needed). Auto-mint `shepaw://peer` QR, then list paired devices.
 *
 * Default path assumes LAN or a public IP — show the QR immediately so the
 * user can scan. External access (hosted Channel / self-hosted Channel) is
 * behind a prominent disclosure. Reverse-proxy setup stays out of this page
 * for now; it added more choices than it was worth.
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
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const [externalOpen, setExternalOpen] = useState(false);
  const [method, setMethod] = useState<ExternalMethod | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoQrDone = useRef(false);
  const methodPicked = useRef(false);

  const load = async () => {
    const peerRes = await api.peer.get();
    setStatus(peerRes.status);
    setDevices(peerRes.devices);
    const gw = await api.gateway.get();
    setGateway(gw);
    return { peerStatus: peerRes.status, gateway: gw };
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
        if ((gw?.channel || gw?.reverseProxy) && !gw.status.running) {
          try {
            await api.gateway.start();
            if (cancelled) return;
            ({ peerStatus, gateway: gw } = await load());
          } catch {
            /* remote access misconfigured — pairing tab still works on LAN */
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

  // Already tunnelling? Open the Channel form so operators can manage it.
  useEffect(() => {
    if (methodPicked.current || !gateway) return;
    methodPicked.current = true;
    if (gateway.channel) {
      setExternalOpen(true);
      setMethod('channel');
    }
  }, [gateway]);

  useEffect(() => {
    const id = setInterval(() => {
      void api.peer.get()
        .then((res) => {
          setStatus(res.status);
          setDevices(res.devices);
        })
        .catch(() => { /* keep last snapshot */ });
    }, 4000);
    return () => clearInterval(id);
  }, []);

  /** Start Peer if it is not running, then mint a QR. Hero CTA + refresh share this. */
  const mintFromHero = async () => {
    setBusy(true); setErr(null);
    try {
      if (!(status?.running ?? false)) {
        await api.peer.start();
        await load();
      }
      setPairing(await api.peer.pair());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
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
  const revoke = async (fp: string) => {
    setBusy(true); setErr(null);
    try { await api.peer.removeDevice(fp); await load(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  /**
   * A saved Channel changes the QR payload (`channel=` entry), so refresh the
   * gateway view and mint a fresh code — otherwise the phone keeps scanning a
   * LAN-only QR.
   */
  const handleChannelChanged = async () => {
    try {
      await load();
      if (status?.running ?? true) setPairing(await api.peer.pair());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const running = status?.running ?? false;
  const hasRemoteExposure = Boolean(gateway?.channel || gateway?.reverseProxy);
  const configuringChannel = method === 'channel' || method === 'selfhost';

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

      <div style={split}>
        <aside style={deviceRail} aria-label={t('peer.devicesAria')}>
          <div style={railHead}>
            <span style={railIcon}><IconPeer size={16} /></span>
            <h3 style={railTitle}>{t('peer.devicesTitle', { count: devices.length })}</h3>
          </div>
          <div style={deviceList}>
            {devices.length === 0 ? (
              <div style={emptyBox}>
                <p style={emptyTitle}>{t('peer.noDevices')}</p>
                <p style={emptyHint}>{t('peer.devicesEmptyHint')}</p>
              </div>
            ) : (
              devices.map((d) => (
                <DeviceCard
                  key={d.fingerprint}
                  device={d}
                  busy={busy}
                  onOpenStore={() => {
                    const uri = `store://files/${d.fingerprint}/`;
                    location.hash = `#store/${encodeURIComponent(uri)}`;
                  }}
                  onRevoke={() => void revoke(d.fingerprint)}
                />
              ))
            )}
          </div>
        </aside>

        <div style={pairCol}>
          <div style={appBar}>
            <div>
              <div style={appBarTitle}>{t('connect.appHint')}</div>
              <div style={noAppHint}>{t('peer.noAppHint')}</div>
            </div>
            <a href={SHEPAW_APP_DOWNLOAD_URL} target="_blank" rel="noreferrer" style={downloadLink}>
              {t('peer.downloadApp')} ↗
            </a>
          </div>

          <div style={heroCard}>
            {booting && !pairing ? (
              <p style={{ color: chat.colors.textSecondary, fontSize: 13, margin: 0 }}>{t('peer.preparingQr')}</p>
            ) : !pairing ? (
              <>
                <p style={heroEmptyHint}>{t('peer.heroEmptyHint')}</p>
                <button
                  type="button"
                  style={primaryBtn}
                  disabled={busy || !status}
                  onClick={() => void mintFromHero()}
                >
                  {busy ? t('peer.minting') : running ? t('peer.mint') : t('peer.mintStart')}
                </button>
              </>
            ) : (
              <>
                <div style={qrPlate}>
                  <QRCodeSVG value={pairing.qrPayload} size={196} bgColor="#ffffff" fgColor="#11111b" />
                </div>
                <p style={pairCode}>{pairing.code}</p>
                <p style={{ color: chat.colors.textSecondary, fontSize: 13, margin: 0 }}>
                  {secondsLeft > 0 ? t('peer.expiresIn', { seconds: secondsLeft }) : t('peer.expired')}
                </p>
                <p style={{
                  ...qrNote,
                  color: hasRemoteExposure
                    ? (gateway?.status.running ? chat.colors.success : '#f9e2af')
                    : chat.colors.textMuted,
                }}>
                  {hasRemoteExposure
                    ? (gateway?.status.running ? t('peer.qrRemoteOk') : t('peer.remoteWarn'))
                    : configuringChannel
                      ? t('connect.qrChannelHint')
                      : t('peer.qrNote')}
                </p>
                <button
                  type="button"
                  style={{ ...secondaryBtn, marginTop: 14 }}
                  disabled={busy || !status}
                  onClick={() => void mintFromHero()}
                >
                  {t('peer.refreshQr')}
                </button>
              </>
            )}

            {err && !/unauthorized|SHEPAW_HUB_TOKEN/i.test(err) && (
              <p style={errText}>{err}</p>
            )}
          </div>

          <div style={externalBox}>
            <button
              type="button"
              style={externalCta(hasRemoteExposure, externalOpen)}
              aria-expanded={externalOpen}
              onClick={() => setExternalOpen((v) => !v)}
            >
              <span style={externalCtaText}>
                <strong style={externalCtaTitle}>
                  {hasRemoteExposure ? t('connect.externalConfigured') : t('connect.needExternal')}
                </strong>
                <span style={externalCtaHint}>{t('connect.needExternalHint')}</span>
              </span>
              <span style={externalCtaAction(hasRemoteExposure)}>
                {externalOpen
                  ? t('common.collapse')
                  : hasRemoteExposure
                    ? t('common.expand')
                    : t('connect.configureExternal')}
              </span>
            </button>

            {externalOpen && (
              <div style={externalBody}>
                <p style={pickTitle}>{t('connect.externalTitle')}</p>
                <div style={methodList} role="radiogroup" aria-label={t('connect.externalTitle')}>
                  {CONNECT_METHODS.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={method === option.id}
                      style={methodCard(method === option.id)}
                      onClick={() => setMethod(option.id)}
                    >
                      <span style={methodRadio}>{method === option.id ? '●' : '○'}</span>
                      <span style={methodText}>
                        <strong style={methodTitle}>{t(option.titleKey)}</strong>
                        <span style={methodDesc}>{t(option.descKey)}</span>
                      </span>
                    </button>
                  ))}
                </div>

                {method === 'channel' && (
                  <>
                    <PublicChannelGuide />
                    <div style={channelForm}>
                      <ChannelSettingsPanel onChanged={() => void handleChannelChanged()} />
                    </div>
                  </>
                )}

                {method === 'selfhost' && (
                  <SelfHostChannelGuide onDone={() => setMethod('channel')} />
                )}
              </div>
            )}
          </div>

          <div style={advancedBox}>
            <button
              type="button"
              style={collapseHeader}
              aria-expanded={advancedExpanded}
              onClick={() => setAdvancedExpanded((v) => !v)}
            >
              <span style={collapseTitleRow}>
                <span style={chevron}>{advancedExpanded ? '▾' : '▸'}</span>
                <span style={sectionTitleInline}>{t('peer.advancedTitle')}</span>
              </span>
              <span style={collapseAction}>{advancedExpanded ? t('common.collapse') : t('common.expand')}</span>
            </button>
            {!advancedExpanded && (
              <p style={channelCollapsedHint}>
                {t('peer.advancedHint')}
              </p>
            )}
            {advancedExpanded && (
              <>
                <div style={statusRow}>
                  <div>
                    <span style={dot(running)} />
                    <strong style={{ color: chat.colors.textPrimary }}>
                      {booting && !status
                        ? t('peer.statusBooting')
                        : running
                          ? t('peer.statusRunning', { pid: status?.pid ?? '' })
                          : t('peer.statusStopped')}
                    </strong>
                    {status && <span style={{ color: chat.colors.textMuted, fontSize: 12, marginLeft: 8 }}>{t('peer.port', { port: status.port })}</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {running
                      ? <button style={dangerBtn} disabled={busy || booting} onClick={() => void stop()}>{t('common.stop')}</button>
                      : <button style={primaryBtn} disabled={busy || booting} onClick={() => void start()}>{t('common.start')}</button>}
                  </div>
                </div>

                {pairing && (
                  <div style={{ marginTop: 12 }}>
                    <p style={hint}>
                      {t('peer.deviceName', { name: pairing.deviceName })}
                      <br />
                      {t('peer.lan', { endpoint: pairing.localEndpoint })}
                      {pairing.channelEndpoint && (
                        <>
                          <br />
                          {gateway?.channel
                            ? t('peer.channel', { endpoint: pairing.channelEndpoint })
                            : t('peer.remote', { endpoint: pairing.channelEndpoint })}
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
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/** How the phone reaches this machine from outside the LAN. */
const CONNECT_METHODS: ReadonlyArray<{
  id: ExternalMethod;
  titleKey: MessageKey;
  descKey: MessageKey;
}> = [
  { id: 'channel', titleKey: 'connect.optChannel.title', descKey: 'connect.optChannel.desc' },
  { id: 'selfhost', titleKey: 'connect.optSelfHost.title', descKey: 'connect.optSelfHost.desc' },
];

function DeviceCard({
  device,
  busy,
  onOpenStore,
  onRevoke,
}: {
  device: PairedPeer;
  busy: boolean;
  onOpenStore: () => void;
  onRevoke: () => void;
}) {
  const { t, locale } = useI18n();
  const name = device.deviceName || device.deviceId || device.fingerprint;
  const initial = name.trim().slice(0, 1).toUpperCase() || 'P';
  return (
    <article style={deviceCard}>
      <div style={deviceTop}>
        <span style={avatar}>{initial}</span>
        <div style={deviceMeta}>
          <div style={deviceName}>{name}</div>
          <div style={deviceSub}>{t('peer.pairedAt', { time: formatPairedAt(device.pairedAt, locale) })}</div>
          <code style={deviceFp} title={device.fingerprint}>
            {device.fingerprint.length > 12 ? `${device.fingerprint.slice(0, 10)}…` : device.fingerprint}
          </code>
        </div>
      </div>
      <div style={deviceActions}>
        <button type="button" style={ghostBtn} onClick={onOpenStore}>
          <IconStore size={14} />
          {t('peer.openStore')}
        </button>
        <button type="button" style={dangerBtn} disabled={busy} onClick={onRevoke}>
          {t('peer.revoke')}
        </button>
      </div>
    </article>
  );
}

function formatPairedAt(iso: string, locale: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function dot(running: boolean): React.CSSProperties {
  return { display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: running ? chat.colors.success : chat.colors.textMuted, marginRight: 8, verticalAlign: 'middle' };
}

const { colors, radius, shadow } = chat;

const split: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 20,
  flexWrap: 'wrap',
};
const deviceRail: React.CSSProperties = {
  flex: '0 1 320px',
  width: 320,
  minWidth: 260,
  position: 'sticky',
  top: 0,
  background: colors.bgSurface,
  border: `1px solid ${colors.borderSubtle}`,
  borderRadius: radius.lg,
  padding: 14,
  boxSizing: 'border-box',
};
const railHead: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  marginBottom: 14,
};
const railIcon: React.CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: 9,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: colors.bgSelected,
  color: colors.accent,
  flexShrink: 0,
};
const railTitle: React.CSSProperties = {
  margin: 0,
  color: colors.textPrimary,
  fontSize: 14,
  fontWeight: 700,
  letterSpacing: '-0.01em',
};
const deviceList: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};
const emptyBox: React.CSSProperties = {
  border: `1px dashed ${colors.border}`,
  borderRadius: radius.md,
  padding: '22px 14px',
  textAlign: 'center',
};
const emptyTitle: React.CSSProperties = {
  margin: 0,
  color: colors.textPrimary,
  fontSize: 13,
  fontWeight: 600,
};
const emptyHint: React.CSSProperties = {
  margin: '6px 0 0',
  color: colors.textMuted,
  fontSize: 12,
  lineHeight: 1.5,
};
const deviceCard: React.CSSProperties = {
  background: colors.bgElevated,
  border: `1px solid ${colors.borderSubtle}`,
  borderRadius: radius.md,
  padding: 12,
};
const deviceTop: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
};
const avatar: React.CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: radius.full,
  background: 'rgba(137, 180, 250, 0.16)',
  color: colors.accent,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 14,
  fontWeight: 700,
  flexShrink: 0,
};
const deviceMeta: React.CSSProperties = { minWidth: 0, flex: 1 };
const deviceName: React.CSSProperties = {
  color: colors.textPrimary,
  fontSize: 13,
  fontWeight: 600,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const deviceSub: React.CSSProperties = {
  marginTop: 2,
  color: colors.textMuted,
  fontSize: 11,
};
const deviceFp: React.CSSProperties = {
  display: 'block',
  marginTop: 4,
  color: colors.textSecondary,
  fontSize: 11,
};
const deviceActions: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  marginTop: 10,
  flexWrap: 'wrap',
};
const ghostBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  background: 'transparent',
  color: colors.textPrimary,
  border: `1px solid ${colors.border}`,
  borderRadius: radius.sm,
  padding: '5px 10px',
  cursor: 'pointer',
  fontSize: 12,
};
const pairCol: React.CSSProperties = {
  flex: '1 1 420px',
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
};
const qrPlate: React.CSSProperties = {
  display: 'inline-flex',
  padding: 12,
  background: '#ffffff',
  borderRadius: radius.md,
  boxShadow: shadow.sm,
};
const appBar: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 12,
  flexWrap: 'wrap',
  background: colors.bgSurface,
  border: `1px solid ${colors.borderSubtle}`,
  borderRadius: radius.lg,
  padding: '14px 16px',
  marginBottom: 14,
};
const appBarTitle: React.CSSProperties = {
  color: colors.textPrimary,
  fontSize: 13,
  fontWeight: 600,
};
const noAppHint: React.CSSProperties = {
  color: colors.textMuted,
  fontSize: 12,
  margin: '2px 0 0',
  lineHeight: 1.5,
};
const downloadLink: React.CSSProperties = {
  display: 'inline-block',
  background: colors.accent,
  color: colors.accentFg,
  borderRadius: radius.full,
  padding: '7px 14px',
  fontSize: 13,
  fontWeight: 600,
  textDecoration: 'none',
  flexShrink: 0,
};
const heroCard: React.CSSProperties = {
  textAlign: 'center',
  background: colors.bgSurface,
  border: `1px solid ${colors.borderSubtle}`,
  borderRadius: radius.lg,
  padding: '28px 20px',
  marginBottom: 14,
};
const heroEmptyHint: React.CSSProperties = { color: '#a6adc8', fontSize: 13, margin: '0 0 14px' };
const pairCode: React.CSSProperties = { color: '#a6e3a1', fontSize: 24, letterSpacing: 6, margin: '12px 0 4px' };
const qrNote: React.CSSProperties = { color: '#6c7086', fontSize: 12, margin: '10px 0 0' };
const errText: React.CSSProperties = { color: '#f38ba8', fontSize: 13, margin: '12px 0 0' };
const externalBox: React.CSSProperties = { marginBottom: 14 };
function externalCta(configured: boolean, open: boolean): React.CSSProperties {
  const accent = configured ? colors.success : '#f9e2af';
  return {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    width: '100%',
    textAlign: 'left',
    background: configured ? 'rgba(166, 227, 161, 0.10)' : 'rgba(249, 226, 175, 0.14)',
    border: `1px solid ${accent}`,
    borderRadius: open ? `${radius.lg}px ${radius.lg}px 0 0` : radius.lg,
    padding: '14px 16px',
    cursor: 'pointer',
  };
}
const externalCtaText: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  minWidth: 0,
};
const externalCtaTitle: React.CSSProperties = {
  color: '#cdd6f4',
  fontSize: 14,
  fontWeight: 700,
};
const externalCtaHint: React.CSSProperties = {
  color: '#a6adc8',
  fontSize: 12,
  lineHeight: 1.5,
};
function externalCtaAction(configured: boolean): React.CSSProperties {
  return {
    color: configured ? '#a6e3a1' : '#f9e2af',
    fontSize: 13,
    fontWeight: 700,
    flexShrink: 0,
    whiteSpace: 'nowrap',
  };
}
const externalBody: React.CSSProperties = {
  background: colors.bgSurface,
  border: `1px solid ${colors.border}`,
  borderTop: 'none',
  borderRadius: `0 0 ${radius.lg}px ${radius.lg}px`,
  padding: '14px 16px 16px',
};
const pickTitle: React.CSSProperties = {
  margin: '0 0 10px',
  color: '#cdd6f4',
  fontSize: 13,
  fontWeight: 600,
};
const methodList: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  marginBottom: 4,
};
function methodCard(selected: boolean): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    textAlign: 'left',
    background: selected ? '#313244' : '#11111b',
    border: `1px solid ${selected ? '#89b4fa' : '#313244'}`,
    borderRadius: 8,
    padding: '12px 14px',
    cursor: 'pointer',
  };
}
const methodRadio: React.CSSProperties = { color: '#89b4fa', fontSize: 12, lineHeight: '20px' };
const methodText: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 };
const methodTitle: React.CSSProperties = { color: '#cdd6f4', fontSize: 13, fontWeight: 600 };
const methodDesc: React.CSSProperties = { color: '#a6adc8', fontSize: 12, lineHeight: 1.6 };
const channelForm: React.CSSProperties = {
  marginTop: 12,
  padding: '12px 14px',
  background: '#11111b',
  border: '1px solid #313244',
  borderRadius: 8,
};
const statusRow: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#181825', border: '1px solid #313244', borderRadius: 6, padding: '10px 12px', marginBottom: 12 };
const hint: React.CSSProperties = { color: '#6c7086', fontSize: 12, margin: '0 0 12px' };
const primaryBtn: React.CSSProperties = { background: '#89b4fa', color: '#1e1e2e', border: 'none', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontWeight: 600 };
const secondaryBtn: React.CSSProperties = { background: 'transparent', color: '#cdd6f4', border: '1px solid #45475a', borderRadius: 6, padding: '6px 14px', cursor: 'pointer', fontSize: 13 };
const dangerBtn: React.CSSProperties = { background: '#452632', color: '#f38ba8', border: '1px solid #f38ba8', borderRadius: 5, padding: '6px 12px', cursor: 'pointer', fontSize: 12 };
const linkBox: React.CSSProperties = { marginTop: 14, padding: '10px 12px', background: '#11111b', border: '1px solid #313244', borderRadius: 6, textAlign: 'left' };
const linkLabel: React.CSSProperties = { color: '#a6adc8', fontSize: 12, marginBottom: 6 };
const linkRow: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'stretch' };
const linkCode: React.CSSProperties = { flex: 1, padding: '6px 8px', background: '#181825', border: '1px solid #313244', borderRadius: 4, color: '#89dceb', fontSize: 11, wordBreak: 'break-all', overflow: 'hidden' };
const copyBtn: React.CSSProperties = { background: '#313244', color: '#cdd6f4', border: '1px solid #45475a', borderRadius: 4, padding: '0 12px', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' };
const linkHint: React.CSSProperties = { color: '#6c7086', fontSize: 11, marginTop: 8, lineHeight: 1.5 };
const advancedBox: React.CSSProperties = {
  marginTop: 2,
  background: colors.bgSurface,
  border: `1px solid ${colors.borderSubtle}`,
  borderRadius: radius.lg,
  padding: '12px 16px 14px',
};
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
  background: colors.bgSurface, border: '1px solid #f9e2af', borderRadius: radius.md,
  padding: '14px 16px', marginBottom: 16,
};
