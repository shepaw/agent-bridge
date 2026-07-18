import { useEffect, useState } from 'react';
import { getHubAuthToken, setHubAuthToken } from '../api/client.js';

/**
 * Persist the dashboard Bearer token in localStorage so API / WebSocket
 * requests can send Authorization when SHEPAW_HUB_TOKEN is enabled.
 */
export function HubAuthTokenPanel({ onSaved }: { onSaved?: () => void }) {
  const [draft, setDraft] = useState('');
  const [hasToken, setHasToken] = useState(false);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = async () => {
    setHasToken(Boolean(getHubAuthToken()));
    try {
      const res = await fetch('/api/health');
      const body = (await res.json()) as { authRequired?: boolean };
      setAuthRequired(Boolean(body.authRequired));
    } catch {
      setAuthRequired(null);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const save = async () => {
    const next = draft.trim();
    if (next.length === 0) {
      setErr('请输入与启动 Hub 时相同的 SHEPAW_HUB_TOKEN');
      return;
    }
    setBusy(true);
    setErr(null);
    setNotice(null);
    setHubAuthToken(next);
    try {
      const res = await fetch('/api/instances', {
        headers: { Authorization: `Bearer ${next}` },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setHubAuthToken(null);
        setErr(body.error ?? `校验失败（HTTP ${res.status}）`);
        setHasToken(false);
        return;
      }
      setDraft('');
      setHasToken(true);
      setNotice('Token 已保存，后续 API 请求将自动携带。');
      onSaved?.();
    } catch (e) {
      setHubAuthToken(null);
      setErr(e instanceof Error ? e.message : String(e));
      setHasToken(false);
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const clear = () => {
    setHubAuthToken(null);
    setDraft('');
    setHasToken(false);
    setNotice('已清除本机 Token。');
    setErr(null);
    onSaved?.();
    void refresh();
  };

  return (
    <>
      <p style={statusLine}>
        服务端鉴权：
        {authRequired === null
          ? '检测中…'
          : authRequired
            ? <span style={{ color: '#f9e2af' }}>已启用</span>
            : <span style={{ color: '#a6e3a1' }}>未启用（本机 loopback 可无 Token）</span>}
        {' · '}
        浏览器：
        {hasToken
          ? <span style={{ color: '#a6e3a1' }}>已配置 Token</span>
          : <span style={{ color: authRequired ? '#f38ba8' : '#6c7086' }}>未配置</span>}
      </p>
      {authRequired && !hasToken && (
        <p style={warn}>
          当前服务端要求 Bearer Token。请填写启动 Hub 时设置的 <code style={code}>SHEPAW_HUB_TOKEN</code>。
        </p>
      )}
      <label style={label}>
        Dashboard Token
        <input
          style={input}
          type="password"
          autoComplete="off"
          placeholder={hasToken ? '••••••••（已保存，输入新值可覆盖）' : '与 SHEPAW_HUB_TOKEN 相同'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
          }}
        />
      </label>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button style={primaryBtn} disabled={busy} onClick={() => void save()}>
          {busy ? '校验中…' : '保存并校验'}
        </button>
        {hasToken && (
          <button style={secondaryBtn} disabled={busy} onClick={clear}>
            清除
          </button>
        )}
      </div>
      {notice && <p style={{ color: '#a6e3a1', fontSize: 13, marginTop: 10 }}>{notice}</p>}
      {err && <p style={{ color: '#f38ba8', fontSize: 13, marginTop: 10 }}>{err}</p>}
    </>
  );
}

const statusLine: React.CSSProperties = { margin: '0 0 10px', color: '#a6adc8', fontSize: 13 };
const warn: React.CSSProperties = { margin: '0 0 12px', color: '#f9e2af', fontSize: 13 };
const code: React.CSSProperties = {
  background: '#181825', border: '1px solid #313244', borderRadius: 4, padding: '0 4px',
};
const label: React.CSSProperties = { display: 'block', color: '#a6adc8', fontSize: 13, margin: '0 0 6px' };
const input: React.CSSProperties = {
  display: 'block', width: '100%', boxSizing: 'border-box', marginTop: 6,
  padding: '8px 10px', background: '#181825', border: '1px solid #313244',
  borderRadius: 6, color: '#cdd6f4',
};
const primaryBtn: React.CSSProperties = {
  background: '#89b4fa', color: '#1e1e2e', border: 'none', borderRadius: 6,
  padding: '8px 16px', cursor: 'pointer', fontWeight: 600,
};
const secondaryBtn: React.CSSProperties = {
  background: 'transparent', color: '#cdd6f4', border: '1px solid #45475a',
  borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontWeight: 600,
};
