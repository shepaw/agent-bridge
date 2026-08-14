import { useEffect, useState } from 'react';
import {
  fetchHubAuthRequired,
  getHubAuthToken,
  setHubAuthToken,
  verifyHubAuthToken,
} from '../api/client.js';
import { useI18n } from '../i18n/index.js';

/**
 * Persist the dashboard Bearer token in localStorage so API / WebSocket
 * requests can send Authorization when SHEPAW_HUB_TOKEN is enabled.
 */
export function HubAuthTokenPanel({ onSaved }: { onSaved?: () => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');
  const [hasToken, setHasToken] = useState(false);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = async () => {
    setHasToken(Boolean(getHubAuthToken()));
    try {
      setAuthRequired(await fetchHubAuthRequired());
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
      setErr(t('auth.enterToken'));
      return;
    }
    setBusy(true);
    setErr(null);
    setNotice(null);
    setHubAuthToken(next);
    try {
      const result = await verifyHubAuthToken(next);
      if (!result.ok) {
        setHubAuthToken(null);
        setErr(result.error);
        setHasToken(false);
        return;
      }
      setDraft('');
      setHasToken(true);
      setNotice(t('auth.saved'));
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
    setNotice(t('auth.cleared'));
    setErr(null);
    onSaved?.();
    void refresh();
  };

  return (
    <>
      <p style={statusLine}>
        {t('auth.server')}
        {authRequired === null
          ? t('auth.checking')
          : authRequired
            ? <span style={{ color: '#f9e2af' }}>{t('auth.serverOn')}</span>
            : <span style={{ color: '#a6e3a1' }}>{t('auth.serverOff')}</span>}
        {' · '}
        {t('auth.browser')}
        {hasToken
          ? <span style={{ color: '#a6e3a1' }}>{t('auth.browserSet')}</span>
          : <span style={{ color: authRequired ? '#f38ba8' : '#6c7086' }}>{t('auth.browserUnset')}</span>}
      </p>
      {authRequired && !hasToken && (
        <p style={warn}>
          {t('auth.bearerRequired')}
        </p>
      )}
      <label style={label}>
        {t('auth.tokenLabel')}
        <input
          style={input}
          type="password"
          autoComplete="off"
          placeholder={hasToken ? t('auth.placeholderSaved') : t('auth.placeholderEmpty')}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
          }}
        />
      </label>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button style={primaryBtn} disabled={busy} onClick={() => void save()}>
          {busy ? t('auth.verifying') : t('auth.saveVerify')}
        </button>
        {hasToken && (
          <button style={secondaryBtn} disabled={busy} onClick={clear}>
            {t('auth.clear')}
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
