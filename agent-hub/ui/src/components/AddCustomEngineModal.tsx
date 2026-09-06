import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useI18n } from '../i18n/index.js';

/**
 * Modal for adding a custom ACP engine from the "My Agents" rail footer.
 * Replaces the compact inline form that used to expand inside the left rail —
 * a narrow 230px column is too small for id / display name / ACP command.
 * On success calls onCreated so the caller can reload engines and close.
 */
export function AddCustomEngineModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useI18n();
  const [id, setId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [acpCommand, setAcpCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Close on Escape like the other rail/menu surfaces.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const engineId = id.trim();
      if (!engineId || !acpCommand.trim()) {
        throw new Error(t('engine.required'));
      }
      await api.engines.create({
        id: engineId,
        displayName: displayName.trim() || engineId,
        acpCommand: acpCommand.trim(),
      });
      onCreated();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={overlay} onClick={() => { if (!busy) onClose(); }}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <h3 style={{ margin: 0, color: '#cdd6f4' }}>{t('engine.addTitle')}</h3>
          <button
            style={busy ? { ...closeBtn, opacity: 0.5, cursor: 'default' } : closeBtn}
            onClick={onClose}
            disabled={busy}
            aria-label={t('common.close')}
          >
            ✕
          </button>
        </div>

        <form onSubmit={(e) => void submit(e)} style={form}>
          <p style={hint}>{t('engine.customHint')}</p>

          <label style={lbl}>{t('engine.engineId')} <span style={req}>*</span></label>
          <input
            style={inp}
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder={t('engine.idPlaceholderShort')}
            autoFocus
            required
          />

          <label style={lbl}>{t('engine.displayName')}</label>
          <input
            style={inp}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={t('engine.namePlaceholderShort')}
          />

          <label style={lbl}>{t('engine.acpCommand')} <span style={req}>*</span></label>
          <input
            style={inp}
            value={acpCommand}
            onChange={(e) => setAcpCommand(e.target.value)}
            placeholder={t('engine.cmdPlaceholderShort')}
            required
          />

          {err && <p style={{ color: '#f38ba8', margin: '2px 0 0' }}>{err}</p>}

          <div style={btnRow}>
            <button type="submit" style={submitBtn} disabled={busy}>
              {busy ? t('common.adding') : t('engine.addEngine')}
            </button>
            <button
              type="button"
              style={busy ? { ...cancelBtn, opacity: 0.6, cursor: 'default' } : cancelBtn}
              onClick={onClose}
              disabled={busy}
            >
              {t('common.cancel')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
};

const modal: React.CSSProperties = {
  background: '#1e1e2e', border: '1px solid #45475a', borderRadius: 10,
  width: '90%', maxWidth: 520, maxHeight: '90vh', overflowY: 'auto',
};

const header: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  padding: '14px 20px', borderBottom: '1px solid #313244',
};

const closeBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', color: '#a6adc8', fontSize: 18, cursor: 'pointer',
};

const form: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 8, padding: 20,
};

const hint: React.CSSProperties = {
  color: '#6c7086', fontSize: 12, margin: '0 0 6px', lineHeight: 1.5,
};

const lbl: React.CSSProperties = { color: '#a6adc8', fontSize: 13 };
const req: React.CSSProperties = { color: '#f38ba8' };

const inp: React.CSSProperties = {
  background: '#11111b', border: '1px solid #45475a', borderRadius: 5,
  color: '#cdd6f4', padding: '8px 12px', fontSize: 14, outline: 'none', fontFamily: 'inherit',
};

const btnRow: React.CSSProperties = {
  display: 'flex', gap: 10, marginTop: 10,
};

const submitBtn: React.CSSProperties = {
  background: '#89b4fa', color: '#11111b', border: 'none',
  borderRadius: 6, padding: '7px 18px', cursor: 'pointer', fontWeight: 600,
};

const cancelBtn: React.CSSProperties = {
  background: 'transparent', border: '1px solid #45475a', color: '#a6adc8',
  borderRadius: 6, padding: '7px 18px', cursor: 'pointer',
};
