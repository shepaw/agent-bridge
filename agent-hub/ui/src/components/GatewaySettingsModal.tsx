import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import type { ApprovalMode, GatewayInfo } from '../api/types.js';

const APPROVAL_KINDS = [
  'read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other',
] as const;

interface GatewaySettingsModalProps {
  onClose: () => void;
}

/**
 * Configure the device-wide shared channel + tunnel router.
 *
 * One channel fronts every managed Agent: set the Channel Service credentials
 * once here, start the router, and every agent becomes reachable from the
 * internet over the single channel (routed by `/p/<projectId>`).
 */
export function GatewaySettingsModal({ onClose }: GatewaySettingsModalProps) {
  const [info, setInfo] = useState<GatewayInfo | null>(null);
  const [serverUrl, setServerUrl] = useState('');
  const [channelId, setChannelId] = useState('');
  const [secret, setSecret] = useState('');
  const [routerPort, setRouterPort] = useState('');
  const [mode, setMode] = useState<ApprovalMode>('ask');
  const [allowKinds, setAllowKinds] = useState<string[]>([]);
  const [askKinds, setAskKinds] = useState<string[]>([]);
  const [allowPatterns, setAllowPatterns] = useState('');
  const [denyPatterns, setDenyPatterns] = useState('');
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
      setMode(g.approval?.mode ?? 'ask');
      setAllowKinds(g.approval?.allowKinds ?? []);
      setAskKinds(g.approval?.askKinds ?? []);
      setAllowPatterns((g.approval?.allowPatterns ?? []).join('\n'));
      setDenyPatterns((g.approval?.denyPatterns ?? []).join('\n'));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleKind = (
    list: string[],
    setList: (v: string[]) => void,
    kind: string,
  ): void => {
    setList(list.includes(kind) ? list.filter((k) => k !== kind) : [...list, kind]);
  };

  const saveApproval = async () => {
    setBusy(true);
    setErr(null);
    setNotice(null);
    try {
      await api.gateway.setApproval({
        mode,
        allowKinds,
        askKinds,
        allowPatterns: allowPatterns.split('\n').map((s) => s.trim()).filter(Boolean),
        denyPatterns: denyPatterns.split('\n').map((s) => s.trim()).filter(Boolean),
      });
      setNotice('已保存审核策略。重启相关 Agent 后生效。');
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const clearApproval = async () => {
    setBusy(true);
    setErr(null);
    setNotice(null);
    try {
      await api.gateway.clearApproval();
      setNotice('已移除审核策略（所有工具调用都将请求 App 审核）。');
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const saveChannel = async () => {
    setBusy(true);
    setErr(null);
    setNotice(null);
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
    setBusy(true);
    setErr(null);
    setNotice(null);
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
    setBusy(true);
    setErr(null);
    setNotice(null);
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
    setBusy(true);
    setErr(null);
    setNotice(null);
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
              <button style={dangerBtn} disabled={busy} onClick={() => void stopRouter()}>
                停止
              </button>
            ) : (
              <button style={primaryBtn} disabled={busy} onClick={() => void startRouter()}>
                启动
              </button>
            )}
          </div>
        </div>

        <div style={section}>
          <h4 style={sectionTitle}>共享 Channel 配置</h4>
          <label style={labelStyle}>Channel Service URL</label>
          <input
            style={input}
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder="https://channel.example.com"
          />
          <label style={labelStyle}>Channel ID</label>
          <input
            style={input}
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            placeholder="ch_abc123"
          />
          <label style={labelStyle}>
            Secret{info?.channel?.secretSet ? '（已设置，留空则保留原值）' : ''}
          </label>
          <input
            style={input}
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={info?.channel?.secretSet ? '••••••••' : 'HMAC-SHA256 secret'}
          />
          <label style={labelStyle}>本地分发端口</label>
          <input
            style={input}
            value={routerPort}
            onChange={(e) => setRouterPort(e.target.value)}
            placeholder="18789"
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button style={primaryBtn} disabled={busy} onClick={() => void saveChannel()}>
              保存 Channel
            </button>
            {info?.channel && (
              <button style={secondaryBtn} disabled={busy} onClick={() => void clearChannel()}>
                移除 Channel
              </button>
            )}
          </div>
        </div>

        <div style={section}>
          <h4 style={sectionTitle}>工具调用审核策略（设备级默认）</h4>
          <p style={{ margin: '0 0 10px', color: '#6c7086', fontSize: 12 }}>
            决定哪些工具调用自动放行/拒绝、哪些必须在 App 端审核。单个 Agent 可用 CLI
            <code style={code}> project set-approval</code> 覆盖。
          </p>

          <label style={labelStyle}>模式</label>
          <select
            style={input}
            value={mode}
            onChange={(e) => setMode(e.target.value as ApprovalMode)}
          >
            <option value="ask">ask — 全部请求 App 审核（最安全）</option>
            <option value="auto">auto — 全部自动放行（deny/always-ask 除外）</option>
            <option value="custom">custom — 按下方规则放行，其余审核</option>
          </select>

          <label style={labelStyle}>自动放行的工具类型</label>
          <div style={kindGrid}>
            {APPROVAL_KINDS.map((k) => (
              <label key={`allow-${k}`} style={kindChip(allowKinds.includes(k))}>
                <input
                  type="checkbox"
                  style={{ marginRight: 5 }}
                  checked={allowKinds.includes(k)}
                  onChange={() => toggleKind(allowKinds, setAllowKinds, k)}
                />
                {k}
              </label>
            ))}
          </div>

          <label style={labelStyle}>始终审核的工具类型（优先级最高）</label>
          <div style={kindGrid}>
            {APPROVAL_KINDS.map((k) => (
              <label key={`ask-${k}`} style={kindChip(askKinds.includes(k))}>
                <input
                  type="checkbox"
                  style={{ marginRight: 5 }}
                  checked={askKinds.includes(k)}
                  onChange={() => toggleKind(askKinds, setAskKinds, k)}
                />
                {k}
              </label>
            ))}
          </div>

          <label style={labelStyle}>自动放行正则（每行一条，匹配标题+命令）</label>
          <textarea
            style={{ ...input, minHeight: 56, fontFamily: 'monospace' }}
            value={allowPatterns}
            onChange={(e) => setAllowPatterns(e.target.value)}
            placeholder={'^npm (test|run)\n^git status'}
          />
          <label style={labelStyle}>自动拒绝正则（每行一条，优先于放行）</label>
          <textarea
            style={{ ...input, minHeight: 56, fontFamily: 'monospace' }}
            value={denyPatterns}
            onChange={(e) => setDenyPatterns(e.target.value)}
            placeholder={'rm -rf\n:(){ :|:& };:'}
          />

          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button style={primaryBtn} disabled={busy} onClick={() => void saveApproval()}>
              保存策略
            </button>
            {info?.approval && (
              <button style={secondaryBtn} disabled={busy} onClick={() => void clearApproval()}>
                移除策略
              </button>
            )}
          </div>
        </div>

        {notice && <p style={{ color: '#a6e3a1', fontSize: 13 }}>{notice}</p>}
        {err && <p style={{ color: '#f38ba8', fontSize: 13 }}>{err}</p>}
      </div>
    </div>
  );
}

function kindChip(active: boolean): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', fontSize: 12,
    padding: '3px 8px', borderRadius: 6, cursor: 'pointer',
    color: active ? '#1e1e2e' : '#cdd6f4',
    background: active ? '#89b4fa' : '#181825',
    border: `1px solid ${active ? '#89b4fa' : '#313244'}`,
  };
}

function statusDot(running: boolean): React.CSSProperties {
  return {
    display: 'inline-block',
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: running ? '#a6e3a1' : '#6c7086',
    marginRight: 8,
    verticalAlign: 'middle',
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
};
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
const section: React.CSSProperties = { marginTop: 16, borderTop: '1px solid #313244', paddingTop: 14 };
const sectionTitle: React.CSSProperties = { margin: '0 0 8px', color: '#cdd6f4', fontSize: 14 };
const kindGrid: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 6 };
const code: React.CSSProperties = {
  background: '#181825', border: '1px solid #313244', borderRadius: 4, padding: '0 4px',
};
const dangerBtn: React.CSSProperties = {
  background: '#452632', color: '#f38ba8', border: '1px solid #f38ba8',
  borderRadius: 5, padding: '6px 14px', cursor: 'pointer', fontSize: 13,
};
