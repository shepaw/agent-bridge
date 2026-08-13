import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import type { GatewayInfo } from '../api/types.js';

/**
 * Shared Channel Service tunnel + tunnel router controls. Used on the Peer
 * pairing tab so remote phones can reach `/peer/ws` via the channel.
 */
export function ChannelSettingsPanel() {
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
        throw new Error('Server URL、Channel ID、Secret 均为必填。');
      }
      await api.gateway.setChannel({
        serverUrl: serverUrl.trim(),
        channelId: channelId.trim(),
        secret: secret.trim(),
        routerPort: routerPort.trim() ? Number(routerPort) : undefined,
      });
      setSecret('');
      setNotice('已保存。若路由器正在运行，请重启以生效。');
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
      setNotice('已移除共享 channel（仅局域网可用）。');
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
            隧道路由器：{running ? `运行中 (pid ${info?.status.pid})` : '已停止'}
          </strong>
          {info && (
            <span style={{ color: '#6c7086', fontSize: 12, marginLeft: 8 }}>
              端口 {info.status.routerPort}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {running ? (
            <button style={dangerBtn} disabled={busy} onClick={() => void stopRouter()}>停止</button>
          ) : (
            <button style={primaryBtn} disabled={busy} onClick={() => void startRouter()}>启动</button>
          )}
        </div>
      </div>

      <p style={channelHint}>
        配置 Channel 后，配对二维码会附带远程入口（<code style={code}>channel=</code>），手机不在同一局域网也可连接。
        远程访问前需启动隧道路由器，并确保 Peer 服务已运行。
      </p>

      <label style={labelStyle}>Channel Service URL</label>
      <input style={input} value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="https://channel.example.com" />
      <label style={labelStyle}>Channel ID</label>
      <input style={input} value={channelId} onChange={(e) => setChannelId(e.target.value)} placeholder="ch_abc123" />
      <label style={labelStyle}>Secret{info?.channel?.secretSet ? '（已设置，留空则保留原值）' : ''}</label>
      <input style={input} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={info?.channel?.secretSet ? '••••••••' : 'HMAC-SHA256 secret'} />
      <label style={labelStyle}>本地分发端口</label>
      <input style={input} value={routerPort} onChange={(e) => setRouterPort(e.target.value)} placeholder="18789" />
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button style={primaryBtn} disabled={busy} onClick={() => void saveChannel()}>保存 Channel</button>
        {info?.channel && (
          <button style={secondaryBtn} disabled={busy} onClick={() => void clearChannel()}>移除 Channel</button>
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
  return (
    <div style={overlay} onClick={onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={modalHeader}>
          <div>
            <h3 style={{ margin: 0, color: '#cdd6f4' }}>网关 / 共享 Channel</h3>
            <p style={{ margin: '6px 0 0', color: '#a6adc8', fontSize: 13 }}>
              一个 channel 代理本机全部 Agent，供外网 Shepaw App 访问
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
const code: React.CSSProperties = { background: '#181825', border: '1px solid #313244', borderRadius: 4, padding: '0 4px' };
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
