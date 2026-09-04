import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import type { GatewayInfo } from '../api/types.js';
import { useI18n } from '../i18n/index.js';

/**
 * Self-managed reverse-proxy exposure (nginx / Caddy / self-built) + router
 * controls. Shown on the Peer pairing tab as an alternative to a shared
 * Channel: the operator points their own public reverse proxy at the hub
 * router, so phones off the LAN can reach `/peer/ws` without any Channel
 * Service or HMAC secret.
 */
export function ReverseProxyPanel({ onChanged }: { onChanged?: () => void }) {
  const { t } = useI18n();
  const [info, setInfo] = useState<GatewayInfo | null>(null);
  const [publicBaseUrl, setPublicBaseUrl] = useState('');
  const [pathPrefix, setPathPrefix] = useState('');
  const [routerPort, setRouterPort] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    try {
      const g = await api.gateway.get();
      setInfo(g);
      setPublicBaseUrl(g.reverseProxy?.publicBaseUrl ?? '');
      setPathPrefix(g.reverseProxy?.pathPrefix ?? '');
      setRouterPort(String(g.routerPort));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const notifyChanged = () => {
    if (onChanged) onChanged();
  };

  /** Map server-side validation codes to localized copy; unknown errors pass through. */
  const localizedError = (e: unknown): string => {
    if (e instanceof Error) {
      const code = (e as Error & { code?: string }).code;
      if (code === 'gateway.required') return t('gateway.revRequired');
      if (code === 'gateway.revBadScheme') {
        // The server reuses revBadScheme for a path prefix that lacks a leading "/".
        return /pathPrefix/i.test(e.message)
          ? t('gateway.revPathPrefixSlash')
          : t('gateway.revBadScheme');
      }
      return e.message;
    }
    return String(e);
  };

  const saveReverseProxy = async () => {
    setBusy(true); setErr(null); setNotice(null);
    try {
      if (!publicBaseUrl.trim()) {
        throw Object.assign(new Error(''), { code: 'gateway.required' });
      }
      const trimmedPrefix = pathPrefix.trim();
      if (trimmedPrefix && !trimmedPrefix.startsWith('/')) {
        throw Object.assign(new Error(t('gateway.revPathPrefixSlash')), {
          code: 'gateway.revBadScheme',
        });
      }
      try {
        await api.gateway.setReverseProxy({
          publicBaseUrl: publicBaseUrl.trim(),
          pathPrefix: trimmedPrefix || undefined,
          routerPort: routerPort.trim() ? Number(routerPort) : undefined,
        });
      } catch (e) {
        throw e instanceof Error ? e : new Error(String(e));
      }
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
      notifyChanged();
    } catch (e) {
      setErr(localizedError(e));
    } finally {
      setBusy(false);
    }
  };

  const clearReverseProxy = async () => {
    setBusy(true); setErr(null); setNotice(null);
    try {
      await api.gateway.clearReverseProxy();
      setNotice(t('gateway.revRemoved'));
      await load();
      notifyChanged();
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
      notifyChanged();
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
      notifyChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const running = info?.status.running ?? false;
  const tunnelAlsoSet = Boolean(info?.channel);

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
        {t('gateway.revHint')}
      </p>

      {info?.reverseProxy?.peerWs && (
        <p style={derivedRow}>
          <span style={{ color: '#a6adc8' }}>{t('gateway.revPeerEntry')}: </span>
          <code style={derivedCode}>{info.reverseProxy.peerWs}</code>
        </p>
      )}

      {tunnelAlsoSet && info?.reverseProxy && (
        <p style={precedenceWarn}>
          {t('gateway.revTunnelWins')}
        </p>
      )}

      <label style={labelStyle}>{t('gateway.revPublicBase')}</label>
      <input style={input} value={publicBaseUrl} onChange={(e) => setPublicBaseUrl(e.target.value)} placeholder="https://agents.example.com" />
      <label style={labelStyle}>{t('gateway.revPathPrefix')}</label>
      <input style={input} value={pathPrefix} onChange={(e) => setPathPrefix(e.target.value)} placeholder="/hub-a" />
      <p style={fieldHint}>{t('gateway.revPathPrefixHint')}</p>
      <label style={labelStyle}>{t('gateway.localPort')}</label>
      <input style={input} value={routerPort} onChange={(e) => setRouterPort(e.target.value)} placeholder="18789" />
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button style={primaryBtn} disabled={busy} onClick={() => void saveReverseProxy()}>{t('gateway.revSave')}</button>
        {info?.reverseProxy && (
          <button style={secondaryBtn} disabled={busy} onClick={() => void clearReverseProxy()}>{t('gateway.revRemove')}</button>
        )}
      </div>

      {notice && <p style={{ color: '#a6e3a1', fontSize: 13, marginTop: 10 }}>{notice}</p>}
      {err && <p style={{ color: '#f38ba8', fontSize: 13, marginTop: 10 }}>{err}</p>}
    </>
  );
}

function statusDot(running: boolean): React.CSSProperties {
  return {
    display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
    background: running ? '#a6e3a1' : '#6c7086', marginRight: 8, verticalAlign: 'middle',
  };
}

const statusRow: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  background: '#181825', border: '1px solid #313244', borderRadius: 6, padding: '10px 12px',
  marginBottom: 12,
};
const channelHint: React.CSSProperties = { color: '#6c7086', fontSize: 12, margin: '0 0 12px' };
const derivedRow: React.CSSProperties = {
  color: '#a6adc8', fontSize: 12, margin: '0 0 12px', wordBreak: 'break-all',
};
const derivedCode: React.CSSProperties = { color: '#89dceb', fontSize: 11 };
const precedenceWarn: React.CSSProperties = {
  color: '#f9e2af', fontSize: 12, margin: '0 0 12px', lineHeight: 1.5,
};
const labelStyle: React.CSSProperties = { display: 'block', color: '#a6adc8', fontSize: 13, margin: '10px 0 6px' };
const fieldHint: React.CSSProperties = { color: '#6c7086', fontSize: 11, margin: '4px 0 0' };
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
