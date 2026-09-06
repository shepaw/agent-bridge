import { useState } from 'react';
import { api } from '../api/client.js';
import { useI18n } from '../i18n/index.js';

/**
 * Compact "add custom engine" form used inside the My Agents engine rail.
 * Mirrors the add-engine handler that used to live on the engine management
 * page (id + display name + ACP command → POST /api/engines).
 */
export function AddCustomEngineForm({ onDone }: { onDone?: () => void }) {
  const { t } = useI18n();
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [cmd, setCmd] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (!id.trim() || !name.trim() || !cmd.trim()) {
        throw new Error(t('engine.required'));
      }
      await api.engines.create({
        id: id.trim(),
        displayName: name.trim(),
        acpCommand: cmd.trim(),
      });
      setId('');
      setName('');
      setCmd('');
      onDone?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={box}>
      <div style={title}>{t('engine.addTitle')}</div>
      <input
        style={input}
        placeholder={t('engine.idPlaceholder')}
        value={id}
        onChange={(e) => setId(e.target.value)}
      />
      <input
        style={input}
        placeholder={t('engine.namePlaceholder')}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        style={input}
        placeholder={t('engine.cmdPlaceholder')}
        value={cmd}
        onChange={(e) => setCmd(e.target.value)}
      />
      <button style={primaryBtn} disabled={busy} onClick={() => void submit()}>
        {busy ? t('common.adding') : t('engine.addEngine')}
      </button>
      {err && <p style={{ color: '#f38ba8', fontSize: 12, margin: 0 }}>{err}</p>}
    </div>
  );
}

const box: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  background: '#181825',
  border: '1px solid #313244',
  borderRadius: 8,
  padding: 10,
  marginTop: 6,
};
const title: React.CSSProperties = {
  color: '#a6adc8',
  fontSize: 12,
  fontWeight: 600,
  margin: 0,
};
const input: React.CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  padding: '6px 8px',
  background: '#11111b',
  border: '1px solid #313244',
  borderRadius: 6,
  color: '#cdd6f4',
  fontSize: 12,
};
const primaryBtn: React.CSSProperties = {
  background: '#89b4fa',
  color: '#11111b',
  border: 'none',
  borderRadius: 6,
  padding: '7px 12px',
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: 12,
};
