import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { api } from '../api/client.js';
import { useI18n } from '../i18n/index.js';
import { chat } from '../utils/chatTheme.js';
import { joinStoreUri } from '../utils/workspaceHref.js';
import { IconAttachments, IconStore } from './NavIcons.js';
import { StorePickerModal, type StorePick, type StorePickerRoot } from './StorePickerModal.js';

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export interface ChatAttachmentRef {
  uri: string;
  name: string;
}

export interface ChatComposerChoice {
  value: string;
  label: string;
  description?: string;
}

interface ChatComposerProps {
  disabled: boolean;
  sending: boolean;
  error: string | null;
  uploadRootUri?: string;
  pickerRoots?: StorePickerRoot[];
  modes?: ChatComposerChoice[];
  currentMode?: string;
  models?: ChatComposerChoice[];
  currentModel?: string;
  optionsLoading?: boolean;
  optionsBusy?: boolean;
  onSelectMode?: (mode: string) => void;
  onSelectModel?: (model: string) => void;
  onSend: (message: string, attachments: ChatAttachmentRef[]) => void;
}

function safeFileName(name: string): string {
  const cleaned = name.replace(/[^\w.\-]+/g, '_');
  return cleaned.length > 0 ? cleaned.slice(0, 80) : 'file';
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    for (let j = 0; j < slice.length; j += 1) {
      binary += String.fromCharCode(slice[j]!);
    }
  }
  return btoa(binary);
}

export function ChatComposer({
  disabled,
  sending,
  error,
  uploadRootUri,
  pickerRoots = [],
  modes = [],
  currentMode,
  models = [],
  currentModel,
  optionsLoading = false,
  optionsBusy = false,
  onSelectMode,
  onSelectModel,
  onSend,
}: ChatComposerProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachmentRef[]>([]);
  const [uploading, setUploading] = useState(false);
  const [attachErr, setAttachErr] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const canUseStore = Boolean(uploadRootUri) || pickerRoots.length > 0;
  const canSend =
    !disabled && !sending && !uploading && (draft.trim().length > 0 || attachments.length > 0);

  const addRefs = (next: ChatAttachmentRef[]) => {
    setAttachments((prev) => {
      const seen = new Set(prev.map((a) => a.uri));
      const extra = next.filter((a) => !seen.has(a.uri));
      return extra.length === 0 ? prev : [...prev, ...extra];
    });
  };

  const uploadFiles = async (files: File[]) => {
    if (!uploadRootUri || files.length === 0) return;
    setUploading(true);
    setAttachErr(null);
    try {
      const added: ChatAttachmentRef[] = [];
      for (const file of files) {
        if (file.size > MAX_UPLOAD_BYTES) {
          setAttachErr(t('sessions.attachTooBig'));
          continue;
        }
        const dest = joinStoreUri(
          uploadRootUri,
          `chat-uploads/${Date.now()}-${safeFileName(file.name)}`,
        );
        if (!dest) continue;
        const buf = await file.arrayBuffer();
        const written = await api.store.write({
          uri: dest,
          contentBase64: bytesToBase64(new Uint8Array(buf)),
        });
        added.push({ uri: written.uri ?? dest, name: file.name });
      }
      addRefs(added);
    } catch (e) {
      setAttachErr(t('sessions.attachFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setUploading(false);
    }
  };

  const submit = () => {
    if (!canSend) return;
    const text = draft;
    const refs = attachments;
    setDraft('');
    setAttachments([]);
    setAttachErr(null);
    onSend(text, refs);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (disabled || sending || !uploadRootUri) return;
    void uploadFiles(Array.from(e.dataTransfer.files));
  };

  return (
    <div style={wrap}>
      {(error !== null || attachErr !== null) && (
        <p style={errorText}>{error ?? attachErr}</p>
      )}
      {attachments.length > 0 && (
        <div style={chipRow}>
          {attachments.map((item) => (
            <span key={item.uri} style={chip} title={item.uri}>
              {item.name}
              <button
                type="button"
                style={chipX}
                aria-label={t('sessions.attachRemove', { name: item.name })}
                onClick={() => setAttachments((prev) => prev.filter((a) => a.uri !== item.uri))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div
        style={{
          ...composerCard,
          borderColor: dragOver ? chat.colors.accent : chat.colors.border,
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (uploadRootUri) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const list = e.target.files ? Array.from(e.target.files) : [];
            e.target.value = '';
            void uploadFiles(list);
          }}
        />
        <textarea
          style={input}
          rows={1}
          value={draft}
          disabled={disabled || sending}
          placeholder={t('sessions.composerPlaceholder')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div style={toolbar}>
          <button
            type="button"
            style={iconBtn}
            disabled={disabled || sending || uploading || !uploadRootUri}
            title={uploadRootUri ? t('sessions.attachFile') : t('sessions.attachNoStore')}
            onClick={() => fileRef.current?.click()}
          >
            <IconAttachments size={16} />
          </button>
          <button
            type="button"
            style={iconBtn}
            disabled={disabled || sending || uploading || pickerRoots.length === 0}
            title={pickerRoots.length > 0 ? t('sessions.attachStore') : t('sessions.attachNoStore')}
            onClick={() => setShowPicker(true)}
          >
            <IconStore size={16} />
          </button>
          <ComposerPicker
            ariaLabel={t('sessions.mode')}
            emptyLabel={t('sessions.mode')}
            options={modes}
            value={currentMode}
            loading={optionsLoading}
            disabled={disabled || sending || optionsBusy}
            onChange={onSelectMode}
          />
          <ComposerPicker
            ariaLabel={t('sessions.model')}
            emptyLabel={t('sessions.model')}
            options={models}
            value={currentModel}
            loading={optionsLoading}
            disabled={disabled || sending || optionsBusy}
            onChange={onSelectModel}
          />
          <span style={{ flex: 1 }} />
          <button
            type="button"
            style={{
              ...sendBtn,
              background: canSend ? chat.colors.accent : chat.colors.bgHover,
              color: canSend ? chat.colors.accentFg : chat.colors.textMuted,
              cursor: canSend ? 'pointer' : 'default',
            }}
            disabled={!canSend}
            title={uploading ? t('sessions.attachUploading') : sending ? t('sessions.sending') : t('sessions.send')}
            onClick={submit}
          >
            {uploading || sending ? '…' : '↑'}
          </button>
        </div>
      </div>
      <p style={hint}>
        {canUseStore ? t('sessions.composerHint') : t('sessions.attachNoStore')}
      </p>
      {showPicker && pickerRoots.length > 0 && (
        <StorePickerModal
          roots={pickerRoots}
          busy={uploading}
          onClose={() => setShowPicker(false)}
          onConfirm={(picks: StorePick[]) => {
            addRefs(picks);
            setShowPicker(false);
          }}
        />
      )}
    </div>
  );
}

function ComposerPicker({
  ariaLabel,
  emptyLabel,
  options,
  value,
  loading,
  disabled,
  onChange,
}: {
  ariaLabel: string;
  emptyLabel: string;
  options: ChatComposerChoice[];
  value?: string;
  loading: boolean;
  disabled: boolean;
  onChange?: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = options.find((item) => item.value === value);
  const label = current?.label ?? (loading ? '…' : emptyLabel);
  const canOpen = !disabled && !loading && options.length > 0 && onChange !== undefined;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  if (!loading && options.length === 0) return null;

  return (
    <div ref={rootRef} style={pickerWrap}>
      <button
        type="button"
        style={{
          ...pickerBtn,
          opacity: canOpen ? 1 : 0.65,
          cursor: canOpen ? 'pointer' : 'default',
        }}
        disabled={!canOpen}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={current?.description || ariaLabel}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span style={pickerLabel}>{label}</span>
        <span style={pickerChevron}>▾</span>
      </button>
      {open && (
        <div role="listbox" style={pickerMenu} aria-label={ariaLabel}>
          {options.map((item) => {
            const selected = item.value === value;
            return (
              <button
                key={item.value}
                type="button"
                role="option"
                aria-selected={selected}
                style={{
                  ...pickerItem,
                  background: selected ? chat.colors.bgSelected : 'transparent',
                  color: selected ? chat.colors.accent : chat.colors.textPrimary,
                }}
                title={item.description}
                onClick={() => {
                  setOpen(false);
                  if (item.value !== value) onChange?.(item.value);
                }}
              >
                <span style={pickerItemTitle}>{item.label}</span>
                {item.description ? (
                  <span style={pickerItemDesc}>{item.description}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const wrap: React.CSSProperties = {
  padding: '12px 16px 14px',
  background: chat.colors.bgSurface,
  boxShadow: chat.shadow.composer,
  flexShrink: 0,
  overflow: 'visible',
  position: 'relative',
  zIndex: 2,
};

const chipRow: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  margin: '0 0 8px 4px',
};

const chip: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  maxWidth: '100%',
  background: chat.colors.bgElevated,
  border: `1px solid ${chat.colors.border}`,
  borderRadius: chat.radius.full,
  padding: '3px 8px 3px 10px',
  color: chat.colors.textPrimary,
  fontSize: 12,
};

const chipX: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: chat.colors.textMuted,
  cursor: 'pointer',
  fontSize: 14,
  lineHeight: 1,
  padding: 0,
};

const composerCard: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '10px 10px 8px',
  background: chat.colors.bgElevated,
  border: `1px solid ${chat.colors.border}`,
  borderRadius: chat.radius.xl,
  boxShadow: chat.shadow.sm,
  overflow: 'visible',
};

const toolbar: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  minWidth: 0,
};

const iconBtn: React.CSSProperties = {
  width: 32,
  height: 32,
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'transparent',
  border: 'none',
  borderRadius: chat.radius.full,
  color: chat.colors.textSecondary,
  cursor: 'pointer',
};

const input: React.CSSProperties = {
  width: '100%',
  resize: 'none',
  background: 'transparent',
  border: 'none',
  color: chat.colors.textPrimary,
  font: 'inherit',
  fontSize: 14,
  lineHeight: 1.5,
  padding: '4px 6px',
  outline: 'none',
  minHeight: 28,
  maxHeight: 160,
  boxSizing: 'border-box',
};

const pickerWrap: React.CSSProperties = {
  position: 'relative',
  flexShrink: 1,
  minWidth: 0,
};

const pickerBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  maxWidth: 168,
  height: 28,
  padding: '0 8px',
  background: chat.colors.bgHover,
  border: `1px solid ${chat.colors.border}`,
  borderRadius: chat.radius.full,
  color: chat.colors.textSecondary,
  font: 'inherit',
  fontSize: 12,
};

const pickerLabel: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const pickerChevron: React.CSSProperties = {
  fontSize: 10,
  color: chat.colors.textMuted,
  flexShrink: 0,
};

const pickerMenu: React.CSSProperties = {
  position: 'absolute',
  left: 0,
  bottom: 'calc(100% + 6px)',
  minWidth: 200,
  maxWidth: 280,
  maxHeight: 240,
  overflowY: 'auto',
  background: chat.colors.bgElevated,
  border: `1px solid ${chat.colors.border}`,
  borderRadius: chat.radius.md,
  boxShadow: chat.shadow.md,
  padding: 4,
  zIndex: 20,
};

const pickerItem: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 2,
  width: '100%',
  textAlign: 'left',
  background: 'transparent',
  border: 'none',
  borderRadius: chat.radius.sm,
  padding: '7px 8px',
  cursor: 'pointer',
  font: 'inherit',
};

const pickerItemTitle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
};

const pickerItemDesc: React.CSSProperties = {
  fontSize: 11,
  color: chat.colors.textMuted,
  lineHeight: 1.35,
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
