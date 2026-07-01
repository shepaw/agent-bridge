import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { api } from '../api/client.js';
import type { HubPairingResult, HubPairedDevice } from '../api/types.js';

interface DevicePairingModalProps {
  onClose: () => void;
}

export function DevicePairingModal({ onClose }: DevicePairingModalProps) {
  const [pairing, setPairing] = useState<HubPairingResult | null>(null);
  const [devices, setDevices] = useState<HubPairedDevice[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadDevices = async () => {
    try {
      const { devices: list } = await api.pair.devices();
      setDevices(list);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    void loadDevices();
  }, []);

  useEffect(() => {
    if (!pairing) {
      setSecondsLeft(0);
      return;
    }
    const tick = () => {
      const left = Math.max(
        0,
        Math.floor((new Date(pairing.expiresAt).getTime() - Date.now()) / 1000),
      );
      setSecondsLeft(left);
      if (left === 0) setPairing(null);
    };
    tick();
    timerRef.current = setInterval(tick, 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [pairing]);

  const mint = async () => {
    setLoading(true);
    setErr(null);
    try {
      const result = await api.pair.mint({
        label: label.trim() || 'Shepaw 设备',
        ttlMinutes: 10,
      });
      setPairing(result);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const revokeDevice = async (fp: string) => {
    try {
      await api.pair.removeDevice(fp);
      await loadDevices();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={modalHeader}>
          <div>
            <h3 style={{ margin: 0, color: '#cdd6f4' }}>设备配对</h3>
            <p style={{ margin: '6px 0 0', color: '#a6adc8', fontSize: 13 }}>
              用 Shepaw App 扫描一次，授权本机上的全部 Agent
            </p>
          </div>
          <button style={closeBtn} onClick={onClose}>×</button>
        </div>

        {!pairing ? (
          <div style={{ marginBottom: 16 }}>
            <label style={labelStyle}>设备名称（可选）</label>
            <input
              style={input}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="例如：iPhone"
            />
            <button style={primaryBtn} disabled={loading} onClick={() => void mint()}>
              {loading ? '生成中…' : '生成配对二维码'}
            </button>
          </div>
        ) : (
          <div style={qrBlock}>
            <QRCodeSVG value={pairing.qrPayload} size={200} bgColor="#1e1e2e" fgColor="#cdd6f4" />
            <p style={{ color: '#a6e3a1', fontSize: 22, letterSpacing: 4, margin: '12px 0 4px' }}>
              {pairing.display}
            </p>
            <p style={{ color: '#a6adc8', fontSize: 13, margin: 0 }}>
              {secondsLeft > 0 ? `${secondsLeft}s 后过期` : '已过期'}
            </p>
            <p style={{ color: '#6c7086', fontSize: 12, marginTop: 8 }}>
              首次连接入口：{pairing.bootstrapProjectId}
            </p>
          </div>
        )}

        <div style={section}>
          <h4 style={sectionTitle}>配对后可用 Agent（{pairing?.agents.length ?? '—'}）</h4>
          <p style={hint}>
            扫码并完成首次连接后，以下 Agent 均已授权。在 App 中「添加远端助手」粘贴各 Agent 的 WS URL 即可（无需再次输入配对码）。
          </p>
          <div style={agentList}>
            {(pairing?.agents ?? []).map((a) => (
              <div key={a.projectId} style={agentRow}>
                <div>
                  <strong style={{ color: '#cdd6f4' }}>{a.label}</strong>
                  <span style={statusDot(a.running)} />
                  <code style={tag}>{a.engine}</code>
                </div>
                <code style={url}>{a.wsUrl}</code>
              </div>
            ))}
            {!pairing && (
              <p style={{ color: '#6c7086', fontSize: 13 }}>生成二维码后显示 Agent 列表</p>
            )}
          </div>
        </div>

        {devices.length > 0 && (
          <div style={section}>
            <h4 style={sectionTitle}>已配对设备</h4>
            {devices.map((d) => (
              <div key={d.fingerprint} style={deviceRow}>
                <div>
                  <strong style={{ color: '#cdd6f4' }}>{d.label || d.fingerprint}</strong>
                  <span style={{ color: '#6c7086', fontSize: 12, marginLeft: 8 }}>
                    {d.projectIds.length} 个 Agent
                  </span>
                </div>
                <button style={dangerBtn} onClick={() => void revokeDevice(d.fingerprint)}>
                  撤销
                </button>
              </div>
            ))}
          </div>
        )}

        {err && <p style={{ color: '#f38ba8', fontSize: 13 }}>{err}</p>}
      </div>
    </div>
  );
}

function statusDot(running: boolean): React.CSSProperties {
  return {
    display: 'inline-block',
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: running ? '#a6e3a1' : '#6c7086',
    marginLeft: 8,
    verticalAlign: 'middle',
  };
}

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
};
const modal: React.CSSProperties = {
  background: '#1e1e2e', border: '1px solid #313244', borderRadius: 10,
  padding: '20px 24px', width: 'min(560px, 92vw)', maxHeight: '90vh', overflow: 'auto',
};
const modalHeader: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16,
};
const closeBtn: React.CSSProperties = {
  background: 'none', border: 'none', color: '#a6adc8', fontSize: 22, cursor: 'pointer',
};
const labelStyle: React.CSSProperties = { display: 'block', color: '#a6adc8', fontSize: 13, marginBottom: 6 };
const input: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '8px 10px', marginBottom: 12,
  background: '#181825', border: '1px solid #313244', borderRadius: 6, color: '#cdd6f4',
};
const primaryBtn: React.CSSProperties = {
  background: '#89b4fa', color: '#1e1e2e', border: 'none', borderRadius: 6,
  padding: '8px 16px', cursor: 'pointer', fontWeight: 600,
};
const qrBlock: React.CSSProperties = { textAlign: 'center', marginBottom: 16 };
const section: React.CSSProperties = { marginTop: 16, borderTop: '1px solid #313244', paddingTop: 14 };
const sectionTitle: React.CSSProperties = { margin: '0 0 8px', color: '#cdd6f4', fontSize: 14 };
const hint: React.CSSProperties = { color: '#6c7086', fontSize: 12, margin: '0 0 10px' };
const agentList: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 };
const agentRow: React.CSSProperties = {
  background: '#181825', border: '1px solid #313244', borderRadius: 6, padding: '8px 10px',
};
const tag: React.CSSProperties = {
  marginLeft: 8, fontSize: 11, padding: '1px 6px', background: '#313244', borderRadius: 4,
};
const url: React.CSSProperties = {
  display: 'block', marginTop: 6, fontSize: 11, color: '#89dceb', wordBreak: 'break-all',
};
const deviceRow: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  padding: '8px 0', borderBottom: '1px solid #313244',
};
const dangerBtn: React.CSSProperties = {
  background: '#452632', color: '#f38ba8', border: '1px solid #f38ba8',
  borderRadius: 5, padding: '4px 10px', cursor: 'pointer', fontSize: 12,
};
