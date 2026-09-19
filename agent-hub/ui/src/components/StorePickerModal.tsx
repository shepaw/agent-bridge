import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import type { StoreEntry } from '../api/types.js';
import { useI18n } from '../i18n/index.js';
import { chat } from '../utils/chatTheme.js';

export interface StorePick {
  uri: string;
  name: string;
}

export interface StorePickerRoot {
  id: string;
  label: string;
  uri: string;
}

interface StorePickerModalProps {
  roots: StorePickerRoot[];
  busy?: boolean;
  onConfirm: (picks: StorePick[]) => void;
  onClose: () => void;
}

function parseStore(uri: string): { space: string; device: string; path: string } | null {
  const m = /^store:\/\/([^/]+)\/([a-f0-9]{16})(?:\/(.*))?$/i.exec(uri.trim());
  if (!m) return null;
  return {
    space: m[1]!,
    device: m[2]!.toLowerCase(),
    path: (m[3] ?? '').replace(/\/+$/, ''),
  };
}

function entryName(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || path;
}

function childUri(parent: string, entry: StoreEntry): string {
  const parsed = parseStore(parent);
  if (!parsed) return parent;
  const path = entry.path.replace(/^\/+|\/+$/g, '');
  return path
    ? `store://${parsed.space}/${parsed.device}/${path}`
    : `store://${parsed.space}/${parsed.device}/`;
}

function parentUri(uri: string): string | null {
  const parsed = parseStore(uri);
  if (!parsed || parsed.path.length === 0) return null;
  const parts = parsed.path.split('/');
  parts.pop();
  return parts.length === 0
    ? `store://${parsed.space}/${parsed.device}/`
    : `store://${parsed.space}/${parsed.device}/${parts.join('/')}`;
}

export function StorePickerModal({
  roots,
  busy = false,
  onConfirm,
  onClose,
}: StorePickerModalProps) {
  const { t } = useI18n();
  const [rootId, setRootId] = useState(roots[0]?.id ?? '');
  const [uri, setUri] = useState(roots[0]?.uri ?? '');
  const [entries, setEntries] = useState<StoreEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, StorePick>>({});

  const activeRoot = roots.find((r) => r.id === rootId) ?? roots[0];

  useEffect(() => {
    if (!uri) return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setEntries([]);
    void api.store.list(uri, 1)
      .then((res) => {
        if (!cancelled) setEntries(res.entries);
      })
      .catch((e) => {
        if (!cancelled) {
          setEntries([]);
          setErr(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [uri]);

  const picks = useMemo(() => Object.values(selected), [selected]);
  const confirmKey = picks.length === 1 ? 'sessions.pickerConfirm' : 'sessions.pickerConfirmPlural';

  return (
    <div style={overlay} onClick={busy ? undefined : onClose}>
      <div
        style={modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="store-picker-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div style={header}>
          <div>
            <h3 id="store-picker-title" style={title}>{t('sessions.pickerTitle')}</h3>
            <p style={hint}>{t('sessions.pickerHint')}</p>
          </div>
          <button type="button" style={closeBtn} disabled={busy} onClick={onClose} aria-label={t('common.close')}>
            ✕
          </button>
        </div>

        {roots.length > 1 && (
          <div style={rootRow} role="tablist">
            {roots.map((root) => (
              <button
                key={root.id}
                type="button"
                role="tab"
                aria-selected={root.id === rootId}
                style={rootChip(root.id === rootId)}
                onClick={() => {
                  setRootId(root.id);
                  setUri(root.uri);
                }}
              >
                {root.label}
              </button>
            ))}
          </div>
        )}

        <div style={crumbRow}>
          <button
            type="button"
            style={navBtn}
            disabled={!parentUri(uri) || uri === activeRoot?.uri}
            onClick={() => {
              const up = parentUri(uri);
              if (up) setUri(up);
            }}
          >
            ←
          </button>
          <code style={crumb}>{uri}</code>
        </div>

        <div style={list}>
          {loading ? (
            <p style={empty}>{t('common.loading')}</p>
          ) : err ? (
            <p style={errorText}>{err}</p>
          ) : entries.length === 0 ? (
            <p style={empty}>{t('sessions.pickerEmpty')}</p>
          ) : (
            entries.map((entry) => {
              const isDir = entry.kind === 'dir' || entry.path.endsWith('/');
              const next = childUri(uri, entry);
              const name = entryName(entry.path);
              const checked = selected[next] !== undefined;
              return (
                <button
                  key={entry.path}
                  type="button"
                  style={row(checked)}
                  onClick={() => {
                    if (isDir) {
                      setUri(next.endsWith('/') ? next : `${next}/`);
                      return;
                    }
                    setSelected((prev) => {
                      const copy = { ...prev };
                      if (copy[next]) delete copy[next];
                      else copy[next] = { uri: next, name };
                      return copy;
                    });
                  }}
                >
                  <span>{isDir ? '📁' : checked ? '☑' : '☐'}</span>
                  <span style={rowName}>{name}</span>
                  {!isDir && <span style={rowMeta}>{(entry.size / 1024).toFixed(1)} KB</span>}
                </button>
              );
            })
          )}
        </div>

        <div style={footer}>
          <button type="button" style={cancelBtn} disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            style={okBtn}
            disabled={busy || picks.length === 0}
            onClick={() => onConfirm(picks)}
          >
            {t(confirmKey, { count: picks.length })}
          </button>
        </div>
      </div>
    </div>
  );
}

const { colors, radius } = chat;

const overlay: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.6)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 120,
};
const modal: React.CSSProperties = {
  width: 'min(560px, calc(100vw - 32px))',
  maxHeight: 'min(72vh, 640px)',
  display: 'flex',
  flexDirection: 'column',
  background: colors.bgElevated,
  border: `1px solid ${colors.border}`,
  borderRadius: radius.lg,
  overflow: 'hidden',
};
const header: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  gap: 12,
  padding: '16px 16px 10px',
};
const title: React.CSSProperties = {
  margin: 0,
  color: colors.textPrimary,
  fontSize: 16,
  fontWeight: 700,
};
const hint: React.CSSProperties = {
  margin: '4px 0 0',
  color: colors.textMuted,
  fontSize: 12,
  lineHeight: 1.45,
};
const closeBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: colors.textSecondary,
  cursor: 'pointer',
  fontSize: 16,
};
const rootRow: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  padding: '0 16px 10px',
};
const rootChip = (active: boolean): React.CSSProperties => ({
  background: active ? colors.bgSelected : colors.bgSurface,
  color: active ? colors.accent : colors.textSecondary,
  border: `1px solid ${active ? 'rgba(137, 180, 250, 0.35)' : colors.border}`,
  borderRadius: radius.full,
  padding: '5px 10px',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: active ? 600 : 500,
});
const crumbRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '0 16px 10px',
};
const navBtn: React.CSSProperties = {
  background: colors.bgSurface,
  color: colors.textPrimary,
  border: `1px solid ${colors.border}`,
  borderRadius: radius.sm,
  width: 28,
  height: 28,
  cursor: 'pointer',
};
const crumb: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: colors.textMuted,
  fontSize: 11,
};
const list: React.CSSProperties = {
  flex: 1,
  minHeight: 180,
  overflow: 'auto',
  borderTop: `1px solid ${colors.borderSubtle}`,
  padding: 8,
};
const empty: React.CSSProperties = {
  margin: '28px 8px',
  textAlign: 'center',
  color: colors.textMuted,
  fontSize: 13,
};
const errorText: React.CSSProperties = {
  margin: '16px 8px',
  color: colors.error,
  fontSize: 13,
};
const row = (checked: boolean): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  textAlign: 'left',
  background: checked ? colors.bgSelected : 'transparent',
  color: colors.textPrimary,
  border: 'none',
  borderRadius: radius.sm,
  padding: '8px 10px',
  cursor: 'pointer',
  fontSize: 13,
});
const rowName: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const rowMeta: React.CSSProperties = {
  color: colors.textMuted,
  fontSize: 11,
};
const footer: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
  padding: 12,
  borderTop: `1px solid ${colors.borderSubtle}`,
};
const cancelBtn: React.CSSProperties = {
  background: 'transparent',
  color: colors.textSecondary,
  border: `1px solid ${colors.border}`,
  borderRadius: radius.sm,
  padding: '7px 12px',
  cursor: 'pointer',
};
const okBtn: React.CSSProperties = {
  background: colors.accent,
  color: colors.accentFg,
  border: 'none',
  borderRadius: radius.sm,
  padding: '7px 14px',
  cursor: 'pointer',
  fontWeight: 600,
};
