import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.js';
import {
  filterCwdHistory,
  loadCwdHistory,
  seedCwdHistory,
} from '../utils/cwdHistory.js';

export interface CwdPathInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  /** Optional trailing control (e.g. 浏览… button). */
  trailing?: React.ReactNode;
  /** Seed history from existing instance cwd paths. */
  seedPaths?: string[];
  inputStyle?: React.CSSProperties;
}

interface Suggestion {
  path: string;
  kind: 'history' | 'dir';
}

function splitPathQuery(value: string): { parent: string; prefix: string } {
  const idx = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  if (idx < 0) return { parent: '', prefix: value };
  // Keep leading slash as root parent when path is like "/foo"
  const parent = value.slice(0, idx);
  return {
    parent: parent.length > 0 ? parent : value.slice(0, 1),
    prefix: value.slice(idx + 1),
  };
}

export function CwdPathInput({
  value,
  onChange,
  placeholder = '/path/to/instance',
  required,
  trailing,
  seedPaths,
  inputStyle,
}: CwdPathInputProps) {
  const listId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<string[]>(() => loadCwdHistory());
  const [fsSuggestions, setFsSuggestions] = useState<Suggestion[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [loadingFs, setLoadingFs] = useState(false);

  useEffect(() => {
    if (!seedPaths || seedPaths.length === 0) return;
    setHistory(seedCwdHistory(seedPaths));
  }, [seedPaths]);

  const historySuggestions = useMemo((): Suggestion[] => {
    return filterCwdHistory(history, value).map((path) => ({ path, kind: 'history' as const }));
  }, [history, value]);

  // Browse parent dir for prefix completions while typing.
  useEffect(() => {
    if (!open) return;
    const trimmed = value.trim();
    if (!trimmed) {
      setFsSuggestions([]);
      setLoadingFs(false);
      return;
    }

    const { parent, prefix } = splitPathQuery(trimmed);
    // Need a directory parent to browse (absolute-ish or ~).
    const canBrowse =
      parent.startsWith('/') ||
      parent.startsWith('~') ||
      /^[A-Za-z]:[\\/]/.test(parent);

    if (!canBrowse) {
      setFsSuggestions([]);
      setLoadingFs(false);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoadingFs(true);
      void api.fs
        .browse(parent)
        .then((data) => {
          if (cancelled) return;
          const pref = prefix.toLowerCase();
          const dirs = data.entries
            .filter((e) => !pref || e.name.toLowerCase().startsWith(pref))
            .slice(0, 40)
            .map((e) => ({ path: e.path, kind: 'dir' as const }));
          setFsSuggestions(dirs);
        })
        .catch(() => {
          if (!cancelled) setFsSuggestions([]);
        })
        .finally(() => {
          if (!cancelled) setLoadingFs(false);
        });
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [value, open]);

  const suggestions = useMemo(() => {
    const trimmed = value.trim();
    const seen = new Set<string>();
    const merged: Suggestion[] = [];

    const push = (s: Suggestion) => {
      const key = s.path.replace(/\/+$/, '');
      if (seen.has(key)) return;
      // Skip exact current value
      if (key === trimmed.replace(/\/+$/, '') && trimmed.length > 0) return;
      seen.add(key);
      merged.push(s);
    };

    if (!trimmed) {
      for (const s of historySuggestions) push(s);
    } else {
      // History first (prefix match), then filesystem dirs
      for (const s of historySuggestions) push(s);
      for (const s of fsSuggestions) push(s);
    }

    return merged.slice(0, 50);
  }, [value, historySuggestions, fsSuggestions]);

  useEffect(() => {
    setHighlight(0);
  }, [suggestions]);

  const pick = useCallback(
    (path: string, opts?: { keepOpen?: boolean }) => {
      onChange(opts?.keepOpen && !path.endsWith('/') ? `${path}/` : path);
      setOpen(Boolean(opts?.keepOpen));
      inputRef.current?.focus();
    },
    [onChange],
  );

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const emptyHint = open && !value.trim() && history.length === 0 && !loadingFs;
  const showDropdown = open && (suggestions.length > 0 || loadingFs || emptyHint);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showDropdown) {
      if (e.key === 'ArrowDown' && suggestions.length > 0) {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (suggestions.length === 0) return;
      setHighlight((i) => (i + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (suggestions.length === 0) return;
      setHighlight((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === 'Enter' && suggestions[highlight]) {
      e.preventDefault();
      const s = suggestions[highlight]!;
      pick(s.path, { keepOpen: s.kind === 'dir' });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'Tab' && suggestions[highlight]) {
      e.preventDefault();
      const s = suggestions[highlight]!;
      pick(s.path, { keepOpen: s.kind === 'dir' });
    }
  };

  return (
    <div ref={wrapRef} style={row}>
      <div style={fieldWrap}>
        <input
          ref={inputRef}
          style={{ ...baseInput, ...inputStyle }}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            setHistory(loadCwdHistory());
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          required={required}
          autoComplete="off"
          role="combobox"
          aria-expanded={showDropdown}
          aria-controls={listId}
          aria-autocomplete="list"
        />
        {showDropdown && (
          <ul id={listId} role="listbox" style={dropdown}>
            {emptyHint && (
              <li style={emptyItem}>暂无历史路径，直接输入或浏览选择</li>
            )}
            {!value.trim() && suggestions.length > 0 && (
              <li style={sectionLabel}>最近使用</li>
            )}
            {value.trim() && historySuggestions.length > 0 && fsSuggestions.length > 0 && (
              <li style={sectionLabel}>匹配建议</li>
            )}
            {suggestions.map((s, i) => {
              const active = i === highlight;
              return (
                <li
                  key={`${s.kind}:${s.path}`}
                  role="option"
                  aria-selected={active}
                  style={{
                    ...item,
                    ...(active ? itemActive : {}),
                  }}
                  onMouseEnter={() => setHighlight(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(s.path, { keepOpen: s.kind === 'dir' });
                  }}
                >
                  <span style={itemPath}>{s.path}</span>
                  <span style={itemKind}>{s.kind === 'history' ? '历史' : '目录'}</span>
                </li>
              );
            })}
            {loadingFs && suggestions.length === 0 && (
              <li style={emptyItem}>匹配目录中…</li>
            )}
          </ul>
        )}
      </div>
      {trailing}
    </div>
  );
}

const row: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'stretch',
};

const fieldWrap: React.CSSProperties = {
  position: 'relative',
  flex: 1,
  minWidth: 0,
};

const baseInput: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: '#11111b',
  border: '1px solid #45475a',
  borderRadius: 5,
  color: '#cdd6f4',
  padding: '6px 10px',
  fontSize: 14,
  outline: 'none',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};

const dropdown: React.CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  top: 'calc(100% + 4px)',
  zIndex: 20,
  margin: 0,
  padding: '4px 0',
  listStyle: 'none',
  background: '#181825',
  border: '1px solid #45475a',
  borderRadius: 6,
  maxHeight: 220,
  overflowY: 'auto',
  boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
};

const sectionLabel: React.CSSProperties = {
  padding: '4px 10px 2px',
  color: '#6c7086',
  fontSize: 11,
  pointerEvents: 'none',
};

const item: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  padding: '6px 10px',
  cursor: 'pointer',
  color: '#cdd6f4',
  fontSize: 12,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};

const itemActive: React.CSSProperties = {
  background: '#313244',
};

const itemPath: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  minWidth: 0,
};

const itemKind: React.CSSProperties = {
  flexShrink: 0,
  color: '#6c7086',
  fontSize: 10,
  fontFamily: 'system-ui, sans-serif',
};

const emptyItem: React.CSSProperties = {
  padding: '8px 10px',
  color: '#6c7086',
  fontSize: 12,
};
