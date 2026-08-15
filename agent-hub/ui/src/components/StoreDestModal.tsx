import { useState } from 'react';
import { useI18n } from '../i18n/index.js';

export type StoreDestKind = 'copy' | 'move' | 'saveAs';

export interface StoreDestModalProps {
  kind: StoreDestKind;
  defaultValue: string;
  busy?: boolean;
  onConfirm: (value: string) => void;
  onClose: () => void;
}

export function StoreDestModal({
  kind,
  defaultValue,
  busy = false,
  onConfirm,
  onClose,
}: StoreDestModalProps) {
  const { t } = useI18n();
  const [value, setValue] = useState(defaultValue);
  const title =
    kind === 'copy' ? t('store.copyTo') : kind === 'move' ? t('store.moveTo') : t('store.saveAsTitle');
  const label = kind === 'saveAs' ? t('store.destName') : t('store.destUri');
  const placeholder = kind === 'saveAs' ? t('store.filename') : t('store.destPlaceholder');

  return (
    <div style={overlay} onClick={busy ? undefined : onClose}>
      <div
        style={modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="store-dest-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div style={header}>
          <h3 id="store-dest-title" style={{ margin: 0, color: '#cdd6f4', fontSize: 16 }}>
            {title}
          </h3>
          <button style={closeBtn} disabled={busy} onClick={onClose} aria-label={t('common.close')}>
            ✕
          </button>
        </div>
        <div style={body}>
          <label style={lbl}>{label}</label>
          <input
            style={inp}
            autoFocus
            value={value}
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && value.trim() && !busy) onConfirm(value.trim());
            }}
          />
        </div>
        <div style={footer}>
          <button type="button" style={cancelBtn} disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            style={okBtn}
            disabled={busy || !value.trim()}
            onClick={() => onConfirm(value.trim())}
          >
            {busy ? t('common.processing') : t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 120,
};
const modal: React.CSSProperties = {
  background: '#1e1e2e', border: '1px solid #45475a', borderRadius: 10,
  width: '90%', maxWidth: 480,
};
const header: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  padding: '14px 16px', borderBottom: '1px solid #313244',
};
const closeBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', color: '#a6adc8', fontSize: 18, cursor: 'pointer',
};
const body: React.CSSProperties = { padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8 };
const lbl: React.CSSProperties = { color: '#a6adc8', fontSize: 13 };
const inp: React.CSSProperties = {
  background: '#11111b', border: '1px solid #45475a', borderRadius: 5,
  color: '#cdd6f4', padding: '7px 10px', fontSize: 13, outline: 'none',
  fontFamily: 'ui-monospace, Menlo, monospace',
};
const footer: React.CSSProperties = {
  display: 'flex', justifyContent: 'flex-end', gap: 10,
  padding: '12px 16px', borderTop: '1px solid #313244',
};
const cancelBtn: React.CSSProperties = {
  background: 'transparent', border: '1px solid #45475a', color: '#a6adc8',
  borderRadius: 6, padding: '7px 16px', cursor: 'pointer',
};
const okBtn: React.CSSProperties = {
  background: '#89b4fa', color: '#11111b', border: 'none',
  borderRadius: 6, padding: '7px 16px', cursor: 'pointer', fontWeight: 600,
};
