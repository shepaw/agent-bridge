import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { api } from '../api/client.js';
import type { PairedPeer, PeerPairingResult, PeerServiceStatus } from '../api/types.js';

/**
 * Peer pairing panel: start/stop the device peer service, mint a
 * `shepaw://peer` QR for the Shepaw app's "Device Pairing / Scan to Connect"
 * scanner, and list/revoke paired devices.
 */
export function PeerPairingPanel() {
  const [status, setStatus] = useState<PeerServiceStatus | null>(null);
  const [devices, setDevices] = useState<PairedPeer[]>([]);
  const [pairing, setPairing] = useState<PeerPairingResult | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = async () => {
    try {
      const res = await api.peer.get();
      setStatus(res.status);
      setDevices(res.devices);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void load();
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
    try { await api.peer.start(); await load(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const stop = async () => {
    setBusy(true); setErr(null);
    try { await api.peer.stop(); await load(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
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
      <div style={statusRow}>
        <div>
          <span style={dot(running)} />
          <strong style={{ color: '#cdd6f4' }}>Peer 服务：{running ? `运行中 (pid ${status?.pid})` : '已停止'}</strong>
          {status && <span style={{ color: '#6c7086', fontSize: 12, marginLeft: 8 }}>端口 {status.port}</span>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {running
            ? <button style={dangerBtn} disabled={busy} onClick={() => void stop()}>停止</button>
            : <button style={primaryBtn} disabled={busy} onClick={() => void start()}>启动</button>}
        </div>
      </div>
      <p style={hint}>
        用 Shepaw app 的「Device Pairing / Scan to Connect」扫描下方二维码。此 QR 走 peer 协议（<code style={code}>shepaw://peer</code>），
        与「Add Agent」扫码入口的 <code style={code}>shepaw://pair</code> 不同——请确认手机用的是 Device Pairing 扫码器。
      </p>

      {!pairing ? (
        <button style={primaryBtn} disabled={busy || !running} onClick={() => void mint()}>
          {busy ? '生成中…' : '生成配对二维码'}
        </button>
      ) : (
        <div style={qrBlock}>
          <QRCodeSVG value={pairing.qrPayload} size={200} bgColor="#1e1e2e" fgColor="#cdd6f4" />
          <p style={{ color: '#a6e3a1', fontSize: 24, letterSpacing: 6, margin: '12px 0 4px' }}>{pairing.code}</p>
          <p style={{ color: '#a6adc8', fontSize: 13, margin: 0 }}>{secondsLeft > 0 ? `${secondsLeft}s 后过期` : '已过期'}</p>
          <p style={{ color: '#6c7086', fontSize: 12, marginTop: 8 }}>入口：{pairing.localEndpoint}</p>
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
        </div>
      )}

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

      {err && <p style={{ color: '#f38ba8', fontSize: 13 }}>{err}</p>}
    </>
  );
}

function dot(running: boolean): React.CSSProperties {
  return { display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: running ? '#a6e3a1' : '#6c7086', marginRight: 8, verticalAlign: 'middle' };
}

const statusRow: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#181825', border: '1px solid #313244', borderRadius: 6, padding: '10px 12px', marginBottom: 12 };
const hint: React.CSSProperties = { color: '#6c7086', fontSize: 12, margin: '0 0 12px' };
const code: React.CSSProperties = { background: '#181825', border: '1px solid #313244', borderRadius: 4, padding: '0 4px' };
const primaryBtn: React.CSSProperties = { background: '#89b4fa', color: '#1e1e2e', border: 'none', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontWeight: 600 };
const dangerBtn: React.CSSProperties = { background: '#452632', color: '#f38ba8', border: '1px solid #f38ba8', borderRadius: 5, padding: '6px 12px', cursor: 'pointer', fontSize: 12 };
const qrBlock: React.CSSProperties = { textAlign: 'center', marginBottom: 16 };
const linkBox: React.CSSProperties = { marginTop: 14, padding: '10px 12px', background: '#11111b', border: '1px solid #313244', borderRadius: 6, textAlign: 'left' };
const linkLabel: React.CSSProperties = { color: '#a6adc8', fontSize: 12, marginBottom: 6 };
const linkRow: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'stretch' };
const linkCode: React.CSSProperties = { flex: 1, padding: '6px 8px', background: '#181825', border: '1px solid #313244', borderRadius: 4, color: '#89dceb', fontSize: 11, wordBreak: 'break-all', overflow: 'hidden' };
const copyBtn: React.CSSProperties = { background: '#313244', color: '#cdd6f4', border: '1px solid #45475a', borderRadius: 4, padding: '0 12px', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' };
const linkHint: React.CSSProperties = { color: '#6c7086', fontSize: 11, marginTop: 8, lineHeight: 1.5 };
const section: React.CSSProperties = { marginTop: 16, borderTop: '1px solid #313244', paddingTop: 14 };
const sectionTitle: React.CSSProperties = { margin: '0 0 8px', color: '#cdd6f4', fontSize: 14 };
const deviceRow: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #313244' };
