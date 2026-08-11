import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { api } from '../api/client.js';
import type { GatewayInfo, PairedPeer, PeerPairingResult, PeerServiceStatus } from '../api/types.js';
import { ChannelSettingsPanel } from './GatewaySettingsModal.js';
import { HubAuthTokenPanel } from './HubAuthTokenPanel.js';

/**
 * Scan-to-pair panel: Peer service (must be running for the app to connect),
 * auto-mint `shepaw://peer` QR, then optional Channel + paired devices.
 */
export function PeerPairingPanel() {
  const [status, setStatus] = useState<PeerServiceStatus | null>(null);
  const [devices, setDevices] = useState<PairedPeer[]>([]);
  const [pairing, setPairing] = useState<PeerPairingResult | null>(null);
  const [gateway, setGateway] = useState<GatewayInfo | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [booting, setBooting] = useState(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoQrDone = useRef(false);

  const load = async () => {
    const [peerRes, gw] = await Promise.all([api.peer.get(), api.gateway.get()]);
    setStatus(peerRes.status);
    setDevices(peerRes.devices);
    setGateway(gw);
    return peerRes.status;
  };

  // On open: ensure Peer is running, then mint QR so the app can scan immediately.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setBooting(true);
      setErr(null);
      try {
        let peerStatus = await load();
        if (cancelled) return;
        if (!peerStatus.running) {
          await api.peer.start();
          if (cancelled) return;
          peerStatus = await load();
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
            API 鉴权失败。请先配置 Dashboard Token（与启动时的 SHEPAW_HUB_TOKEN 相同）：
          </p>
          <HubAuthTokenPanel
            onSaved={() => {
              setErr(null);
              autoQrDone.current = false;
              void load().then(async (peerStatus) => {
                if (!peerStatus.running) {
                  await api.peer.start();
                  peerStatus = await load();
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
        <h4 style={sectionTitle}>Peer 服务</h4>
        <p style={priorityHint}>
          App 扫码连接前必须先启动 Peer 服务。进入本页会自动启动并打开二维码。
        </p>
        {gateway?.channel && !gateway.status.running && (
          <p style={warn}>
            已配置 Channel 但隧道路由器未运行。远程配对需先启动路由器。
          </p>
        )}
        <div style={statusRow}>
          <div>
            <span style={dot(running)} />
            <strong style={{ color: '#cdd6f4' }}>
              Peer 服务：{booting && !status ? '启动中…' : running ? `运行中 (pid ${status?.pid})` : '已停止'}
            </strong>
            {status && <span style={{ color: '#6c7086', fontSize: 12, marginLeft: 8 }}>端口 {status.port}</span>}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {running
              ? <button style={dangerBtn} disabled={busy || booting} onClick={() => void stop()}>停止</button>
              : <button style={primaryBtn} disabled={busy || booting} onClick={() => void start()}>启动</button>}
          </div>
        </div>
        <p style={hint}>
          用 Shepaw app 的「Device Pairing / Scan to Connect」扫描下方二维码。
          {gateway?.channel
            ? ' 二维码包含局域网与 Channel 远程入口。'
            : ' 当前仅局域网可用；配置 Channel 后可远程连接。'}
        </p>

        {booting && !pairing ? (
          <p style={{ color: '#a6adc8', fontSize: 13, margin: '0 0 8px' }}>正在准备配对二维码…</p>
        ) : !pairing ? (
          <button style={primaryBtn} disabled={busy || !running} onClick={() => void mint()}>
            {busy ? '生成中…' : '生成配对二维码'}
          </button>
        ) : (
          <div style={qrBlock}>
            <QRCodeSVG value={pairing.qrPayload} size={200} bgColor="#1e1e2e" fgColor="#cdd6f4" />
            <p style={{ color: '#a6e3a1', fontSize: 24, letterSpacing: 6, margin: '12px 0 4px' }}>{pairing.code}</p>
            <p style={{ color: '#a6adc8', fontSize: 13, margin: 0 }}>{secondsLeft > 0 ? `${secondsLeft}s 后过期` : '已过期'}</p>
            <p style={{ color: '#6c7086', fontSize: 12, marginTop: 8 }}>
              局域网：{pairing.localEndpoint}
              {pairing.channelEndpoint && (
                <>
                  <br />
                  Channel：{pairing.channelEndpoint}
                </>
              )}
            </p>
            <div style={linkBox}>
              <div style={linkLabel}>配对链接(无摄像头可粘贴此链接到 app「Device Pairing → 输入」)</div>
              <div style={linkRow}>
                <code style={linkCode} title={pairing.qrPayload}>{pairing.qrPayload}</code>
                <button
                  style={copyBtn}
                  onClick={() => { try { void navigator.clipboard.writeText(pairing.qrPayload); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ } }}
                >{copied ? '已复制' : '复制'}</button>
              </div>
              <div style={linkHint}>
                Android 模拟器:把链接里的 <code>{'192.168.x.x'}</code> 改成 <code>10.0.2.2</code>;
                iOS 模拟器可用 <code>localhost</code>。
              </div>
            </div>
            <button
              type="button"
              style={{ ...secondaryBtn, marginTop: 12 }}
              disabled={busy || !running}
              onClick={() => void mint()}
            >
              刷新二维码
            </button>
          </div>
        )}

        {err && !/unauthorized|SHEPAW_HUB_TOKEN/i.test(err) && (
          <p style={{ color: '#f38ba8', fontSize: 13 }}>{err}</p>
        )}
      </div>

      <div style={section}>
        <h4 style={sectionTitle}>共享 Channel（远程访问）</h4>
        <ChannelSettingsPanel />
      </div>

      <div style={section}>
        <h4 style={sectionTitle}>已配对设备（{devices.length}）</h4>
        {devices.length === 0
          ? <p style={hint}>尚未配对设备。</p>
          : devices.map((d) => (
            <div key={d.fingerprint} style={deviceRow}>
              <div>
                <strong style={{ color: '#cdd6f4' }}>{d.deviceName || d.fingerprint}</strong>
                <span style={{ color: '#6c7086', fontSize: 12, marginLeft: 8 }}>{d.fingerprint}</span>
              </div>
              <button style={dangerBtn} disabled={busy} onClick={() => void revoke(d.fingerprint)}>撤销</button>
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
const authBox: React.CSSProperties = {
  background: '#181825', border: '1px solid #f9e2af', borderRadius: 8,
  padding: '14px 16px', marginBottom: 8,
};
const sectionTitle: React.CSSProperties = { margin: '0 0 12px', color: '#cdd6f4', fontSize: 14 };
const deviceRow: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #313244' };
