import type { Locale } from '../i18n/index.js';
import { useI18n } from '../i18n/index.js';

export function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();
  const options: { id: Locale; labelKey: 'lang.zh' | 'lang.en' }[] = [
    { id: 'zh', labelKey: 'lang.zh' },
    { id: 'en', labelKey: 'lang.en' },
  ];
  return (
    <div style={wrap} role="group" aria-label={t('lang.switch')}>
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          style={btn(locale === opt.id)}
          aria-pressed={locale === opt.id}
          onClick={() => setLocale(opt.id)}
        >
          {t(opt.labelKey)}
        </button>
      ))}
    </div>
  );
}

const wrap: React.CSSProperties = {
  display: 'inline-flex',
  border: '1px solid #45475a',
  borderRadius: 6,
  overflow: 'hidden',
  flexShrink: 0,
};

const btn = (active: boolean): React.CSSProperties => ({
  background: active ? '#313244' : 'transparent',
  color: active ? '#89b4fa' : '#a6adc8',
  border: 'none',
  padding: '6px 10px',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: active ? 600 : 400,
});
