interface ConfirmModalProps {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Visual tone for the confirm button. Defaults to warning (yellow). */
  tone?: 'warning' | 'danger' | 'primary';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  title,
  message,
  confirmLabel = '确认',
  cancelLabel = '取消',
  tone = 'warning',
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  return (
    <div style={overlay} onClick={busy ? undefined : onCancel}>
      <div
        style={modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div style={header}>
          <h3 id="confirm-modal-title" style={{ margin: 0, color: '#cdd6f4', fontSize: 16 }}>
            {title}
          </h3>
          <button style={closeBtn} disabled={busy} onClick={onCancel} aria-label="关闭">
            ✕
          </button>
        </div>

        <div style={body}>
          <p style={{ margin: 0, color: '#a6adc8', fontSize: 14, lineHeight: 1.55 }}>
            {message}
          </p>
        </div>

        <div style={footer}>
          <button style={cancelBtn} disabled={busy} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            style={confirmBtn[tone]}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? '处理中...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.6)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 100,
};

const modal: React.CSSProperties = {
  background: '#1e1e2e',
  border: '1px solid #45475a',
  borderRadius: 10,
  width: '90%',
  maxWidth: 420,
  boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
};

const header: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '14px 20px',
  borderBottom: '1px solid #313244',
};

const body: React.CSSProperties = {
  padding: '18px 20px',
};

const footer: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
  padding: '14px 20px',
  borderTop: '1px solid #313244',
};

const closeBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#a6adc8',
  fontSize: 18,
  cursor: 'pointer',
};

const cancelBtn: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid #45475a',
  color: '#a6adc8',
  borderRadius: 6,
  padding: '7px 18px',
  cursor: 'pointer',
  fontSize: 14,
};

const confirmBtn: Record<'warning' | 'danger' | 'primary', React.CSSProperties> = {
  warning: {
    background: '#f9e2af',
    color: '#11111b',
    border: 'none',
    borderRadius: 6,
    padding: '7px 18px',
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: 14,
  },
  danger: {
    background: '#f38ba8',
    color: '#11111b',
    border: 'none',
    borderRadius: 6,
    padding: '7px 18px',
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: 14,
  },
  primary: {
    background: '#89b4fa',
    color: '#11111b',
    border: 'none',
    borderRadius: 6,
    padding: '7px 18px',
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: 14,
  },
};
