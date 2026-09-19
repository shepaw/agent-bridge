import { useState, type KeyboardEvent } from 'react';
import { useI18n } from '../i18n/index.js';

interface ChatComposerProps {
  disabled: boolean;
  sending: boolean;
  error: string | null;
  onSend: (message: string) => void;
}

export function ChatComposer({ disabled, sending, error, onSend }: ChatComposerProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');

  const canSend = !disabled && !sending && draft.trim().length > 0;

  const submit = () => {
    if (!canSend) return;
    const text = draft;
    setDraft('');
    onSend(text);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div style={wrap}>
      {error !== null && <p style={errorText}>{error}</p>}
      <div style={row}>
        <textarea
          style={input}
          rows={2}
          value={draft}
          disabled={disabled || sending}
          placeholder={t('sessions.composerPlaceholder')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          style={{
            ...sendBtn,
            opacity: canSend ? 1 : 0.55,
          }}
          disabled={!canSend}
          onClick={submit}
        >
          {sending ? t('sessions.sending') : t('sessions.send')}
        </button>
      </div>
      <p style={hint}>{t('sessions.autoApproveHint')}</p>
    </div>
  );
}

const wrap: React.CSSProperties = {
  borderTop: '1px solid #313244',
  padding: '8px 10px 10px',
  background: '#1e1e2e',
  flexShrink: 0,
};

const row: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'flex-end',
};

const input: React.CSSProperties = {
  flex: 1,
  resize: 'none',
  background: '#11111b',
  border: '1px solid #45475a',
  borderRadius: 6,
  color: '#cdd6f4',
  font: 'inherit',
  fontSize: 13,
  lineHeight: 1.45,
  padding: '8px 10px',
  outline: 'none',
};

const sendBtn: React.CSSProperties = {
  background: '#89b4fa',
  border: 'none',
  color: '#1e1e2e',
  borderRadius: 6,
  padding: '8px 12px',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
  height: 38,
};

const hint: React.CSSProperties = {
  margin: '6px 0 0',
  fontSize: 11,
  color: '#6c7086',
};

const errorText: React.CSSProperties = {
  margin: '0 0 6px',
  fontSize: 12,
  color: '#f38ba8',
};
