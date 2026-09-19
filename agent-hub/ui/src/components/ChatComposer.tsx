import { useState, type KeyboardEvent } from 'react';
import { useI18n } from '../i18n/index.js';
import { chat } from '../utils/chatTheme.js';

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
      <div style={composerCard}>
        <textarea
          style={input}
          rows={1}
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
            background: canSend ? chat.colors.accent : chat.colors.bgHover,
            color: canSend ? chat.colors.accentFg : chat.colors.textMuted,
            cursor: canSend ? 'pointer' : 'default',
          }}
          disabled={!canSend}
          title={sending ? t('sessions.sending') : t('sessions.send')}
          onClick={submit}
        >
          {sending ? '…' : '↑'}
        </button>
      </div>
      <p style={hint}>
        {t('sessions.composerHint')}
      </p>
    </div>
  );
}

const wrap: React.CSSProperties = {
  padding: '12px 16px 14px',
  background: chat.colors.bgSurface,
  boxShadow: chat.shadow.composer,
  flexShrink: 0,
};

const composerCard: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-end',
  gap: 10,
  padding: '8px 8px 8px 14px',
  background: chat.colors.bgElevated,
  border: `1px solid ${chat.colors.border}`,
  borderRadius: chat.radius.xl,
  boxShadow: chat.shadow.sm,
};

const input: React.CSSProperties = {
  flex: 1,
  resize: 'none',
  background: 'transparent',
  border: 'none',
  color: chat.colors.textPrimary,
  font: 'inherit',
  fontSize: 14,
  lineHeight: 1.5,
  padding: '6px 0',
  outline: 'none',
  minHeight: 28,
  maxHeight: 160,
};

const sendBtn: React.CSSProperties = {
  width: 36,
  height: 36,
  flexShrink: 0,
  border: 'none',
  borderRadius: chat.radius.full,
  fontSize: 18,
  fontWeight: 700,
  lineHeight: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'background 0.15s ease, color 0.15s ease',
};

const hint: React.CSSProperties = {
  margin: '8px 4px 0',
  fontSize: 11,
  color: chat.colors.textMuted,
  lineHeight: 1.4,
};

const errorText: React.CSSProperties = {
  margin: '0 0 8px 4px',
  fontSize: 12,
  color: chat.colors.error,
};
