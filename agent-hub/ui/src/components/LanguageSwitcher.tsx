import type { CSSProperties } from 'react';
import type { Locale } from '../i18n/index.js';
import { useI18n } from '../i18n/index.js';

export function LanguageSwitcher({ fullWidth = false }: { fullWidth?: boolean }) {
  const { locale, setLocale, t } = useI18n();
  const options: { id: Locale; labelKey: 'lang.zh' | 'lang.en' }[] = [
    { id: 'zh', labelKey: 'lang.zh' },
    { id: 'en', labelKey: 'lang.en' },
  ];
  return (
    <div style={wrap(fullWidth)} role="group" aria-label={t('lang.switch')}>
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          style={btn(locale === opt.id, fullWidth)}
          aria-pressed={locale === opt.id}
          onClick={() => setLocale(opt.id)}
        >
          {t(opt.labelKey)}
        </button>
      ))}
    </div>
  );
}

const wrap = (fullWidth: boolean): CSSProperties => ({
  display: 'inline-flex',
  width: fullWidth ? '100%' : undefined,
  border: '1px solid #313244',
  borderRadius: 10,
  overflow: 'hidden',
  flexShrink: 0,
  background: '#11111b',
});

const btn = (active: boolean, fullWidth: boolean): CSSProperties => ({
  flex: fullWidth ? 1 : undefined,
  background: active ? 'rgba(137, 180, 250, 0.14)' : 'transparent',
  color: active ? '#89b4fa' : '#a6adc8',
  border: 'none',
  padding: fullWidth ? '7px 10px' : '6px 10px',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: active ? 600 : 500,
});
