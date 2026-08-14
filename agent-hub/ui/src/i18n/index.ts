import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { en, type MessageKey } from './en.js';
import { zh } from './zh.js';

export type Locale = 'en' | 'zh';
export type { MessageKey };

const STORAGE_KEY = 'shepaw_locale';
const tables: Record<Locale, Record<MessageKey, string>> = { en, zh };

export function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'zh') return saved;
  } catch {
    /* private mode */
  }
  const lang = (typeof navigator !== 'undefined' ? navigator.language : '') || '';
  return lang.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

let currentLocale: Locale = detectLocale();

const listeners = new Set<() => void>();

function notify(): void {
  for (const cb of listeners) cb();
}

export function getLocale(): Locale {
  return currentLocale;
}

export function applyDocumentLang(locale: Locale): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
}

export function persistLocale(locale: Locale): void {
  currentLocale = locale;
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    /* ignore */
  }
  applyDocumentLang(locale);
  notify();
}

export function subscribeLocale(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export type Vars = Record<string, string | number>;

export function translate(locale: Locale, key: MessageKey, vars?: Vars): string {
  const table = tables[locale] ?? tables.en;
  let text = table[key] ?? tables.en[key] ?? key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}

/** Non-React helper (utils, API client). Re-reads the current locale. */
export function t(key: MessageKey, vars?: Vars): string {
  return translate(currentLocale, key, vars);
}

interface I18nValue {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: (key: MessageKey, vars?: Vars) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => detectLocale());

  useEffect(() => {
    currentLocale = locale;
    applyDocumentLang(locale);
  }, [locale]);

  useEffect(() => subscribeLocale(() => setLocaleState(getLocale())), []);

  const setLocale = useCallback((next: Locale) => {
    persistLocale(next);
    setLocaleState(next);
  }, []);

  const tFn = useCallback(
    (key: MessageKey, vars?: Vars) => translate(locale, key, vars),
    [locale],
  );

  const value = useMemo<I18nValue>(
    () => ({ locale, setLocale, t: tFn }),
    [locale, setLocale, tFn],
  );

  return createElement(I18nContext.Provider, { value }, children);
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (ctx === null) {
    return {
      locale: currentLocale,
      setLocale: persistLocale,
      t,
    };
  }
  return ctx;
}
