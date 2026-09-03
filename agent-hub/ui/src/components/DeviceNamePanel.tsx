import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useI18n } from '../i18n/index.js';

/**
 * Edit the device name this hub advertises when a phone pairs. Loads the
 * current effective name (custom value or the machine hostname default) via
 * the peer status API; saving persists it to hub.json, clearing restores the
 * hostname default. Takes effect on the next pairing handshake.
 */
export function DeviceNamePanel() {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.peer.get();
        if (!cancelled) setDraft(res.status.deviceName);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const commit = async (nextRaw: string, allowEmpty: boolean) => {
    const next = nextRaw.trim();
    if (!allowEmpty && next.length === 0) {
      setErr(t('settings.deviceNameEmpty'));
      return;
    }
    if (next.length > 64) {
      setErr(t('settings.deviceNameTooLong'));
      return;
    }
    setBusy(true);
    setErr(null);
    setNotice(null);
    try {
      const res = await api.peer.setDeviceName(next);
      setDraft(res.deviceName);
      setNotice(t('settings.deviceNameSaved'));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <input
        style={input}
        type="text"
        maxLength={64}
        autoComplete="off"
        aria-label={t('settings.deviceNameTitle')}
        placeholder={t('settings.deviceNamePlaceholder')}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit(draft, false);
        }}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button style={primaryBtn} disabled={busy} onClick={() => void commit(draft, false)}>
          {t('settings.deviceNameSave')}
        </button>
        <button style={secondaryBtn} disabled={busy} onClick={() => void commit('', true)}>
          {t('settings.deviceNameReset')}
        </button>
      </div>
      {notice && <p style={{ color: '#a6e3a1', fontSize: 13, marginTop: 10 }}>{notice}</p>}
      {err && <p style={{ color: '#f38ba8', fontSize: 13, marginTop: 10 }}>{err}</p>}
    </>
  );
}

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
