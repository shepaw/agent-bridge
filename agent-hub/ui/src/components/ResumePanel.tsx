/**
 * Per-instance 简历 (resume) panel: view the current agent card resume,
 * edit the custom resume-generation prompt (提示词), and regenerate —
 * either deterministically (workspace re-scan) or via AI polish (a chat
 * turn in which the agent rewrites its own Summary per the prompt).
 */

import { useEffect, useState } from 'react';

import { api } from '../api/client.js';
import type { Instance } from '../api/types.js';
import { t } from '../i18n/index.js';

const RESUME_PROMPT_MAX_LENGTH = 8000;

type Props = {
  instance: Instance;
  /** Reload the instance detail (after prompt save / rebuild / polish). */
  onChanged: () => void;
};

export function ResumePanel({ instance, onChanged }: Props) {
  const savedPrompt = instance.resumePrompt ?? '';
  const [promptDraft, setPromptDraft] = useState(savedPrompt);
  const [saveBusy, setSaveBusy] = useState(false);
  const [rebuildBusy, setRebuildBusy] = useState(false);
  const [polishBusy, setPolishBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [polishReply, setPolishReply] = useState<string | null>(null);

  // Reset the draft when the instance (or its saved prompt) changes.
  useEffect(() => {
    setPromptDraft(instance.resumePrompt ?? '');
  }, [instance.id, instance.resumePrompt]);

  const dirty = promptDraft !== savedPrompt;
  const offline = instance.card === null || instance.card === undefined;

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setNotice(null);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const savePrompt = (): Promise<void> =>
    run(async () => {
      setSaveBusy(true);
      try {
        await api.instances.update(instance.id, { resumePrompt: promptDraft });
        setNotice(t('detail.promptSaved'));
        onChanged();
      } finally {
        setSaveBusy(false);
      }
    });

  const clearPrompt = (): Promise<void> =>
    run(async () => {
      setSaveBusy(true);
      try {
        setPromptDraft('');
        await api.instances.update(instance.id, { resumePrompt: '' });
        setNotice(t('detail.promptCleared'));
        onChanged();
      } finally {
        setSaveBusy(false);
      }
    });

  const rebuild = (): Promise<void> =>
    run(async () => {
      setRebuildBusy(true);
      try {
        await api.instances.rebuildResume(instance.id);
        onChanged();
        setNotice(t('detail.rebuildDone', { time: new Date().toLocaleTimeString() }));
      } finally {
        setRebuildBusy(false);
      }
    });

  const polish = (): Promise<void> =>
    run(async () => {
      if (promptDraft.trim().length === 0 && savedPrompt.trim().length === 0) {
        setError(t('detail.polishNeedsPrompt'));
        return;
      }
      setPolishBusy(true);
      setPolishReply(null);
      try {
        const result = await api.instances.polishResume(instance.id);
        onChanged();
        setPolishReply(result.reply || null);
        setNotice(t('detail.polishDone', { time: new Date().toLocaleTimeString() }));
      } finally {
        setPolishBusy(false);
      }
    });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {offline && (
        <p style={offlineBanner}>⚠ {t('detail.resumeOffline')}</p>
      )}

      {/* ── 当前简历 ─────────────────────────────────────────── */}
      <div style={card}>
        <div style={label}>{t('detail.resumeCurrent')}</div>
        <p style={resumeText}>
          {instance.card?.description || instance.card?.bio || '—'}
        </p>
        {(instance.card?.capabilities.length ?? 0) > 0 && (
          <div style={{ ...capRow, marginTop: 10 }}>
            {instance.card!.capabilities.map((c) => (
              <code key={c} style={capChip}>{c}</code>
            ))}
          </div>
        )}
      </div>

      {/* ── 提示词编辑器 ─────────────────────────────────────── */}
      <div style={card}>
        <div style={label}>{t('detail.resumePromptLabel')}</div>
        <p style={hint}>{t('detail.resumePromptHint')}</p>
        <textarea
          value={promptDraft}
          maxLength={RESUME_PROMPT_MAX_LENGTH}
          rows={8}
          placeholder={t('detail.resumePromptPlaceholder')}
          onChange={(e) => setPromptDraft(e.target.value)}
          style={textarea}
        />
        <div style={promptFooterRow}>
          <span style={charCount}>{promptDraft.length} / {RESUME_PROMPT_MAX_LENGTH}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              style={secondaryBtn}
              disabled={saveBusy || (promptDraft.trim().length === 0 && savedPrompt.length === 0)}
              onClick={() => void clearPrompt()}
            >
              {t('detail.clearPrompt')}
            </button>
            <button
              type="button"
              style={primaryBtn}
              disabled={saveBusy || !dirty}
              onClick={() => void savePrompt()}
            >
              {t('detail.savePrompt')}
            </button>
          </div>
        </div>
      </div>

      {/* ── 重新生成 ─────────────────────────────────────────── */}
      <div style={card}>
        <div style={actionRow}>
          <div style={{ flex: 1 }}>
            <div style={label}>{t('detail.rebuildDeterministic')}</div>
            <p style={hint}>{t('detail.rebuildDeterministicHint')}</p>
          </div>
          <button
            type="button"
            style={secondaryBtn}
            disabled={rebuildBusy || offline}
            onClick={() => void rebuild()}
          >
            {rebuildBusy ? t('detail.rebuilding') : t('detail.rebuildDeterministic')}
          </button>
        </div>
        <div style={{ ...actionRow, borderTop: '1px solid #313244', paddingTop: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={label}>{t('detail.polishResume')}</div>
            <p style={hint}>{t('detail.polishResumeHint')}</p>
          </div>
          <button
            type="button"
            style={primaryBtn}
            disabled={polishBusy || offline || (promptDraft.trim().length === 0 && savedPrompt.trim().length === 0)}
            onClick={() => void polish()}
          >
            {t('detail.polishResume')}
          </button>
        </div>
        {polishBusy && <p style={busyText}>{t('detail.polishing')}</p>}
      </div>

      {notice && <p style={noticeText}>{notice}</p>}
      {error && <p style={errorText}>{error}</p>}

      {polishReply !== null && !polishBusy && (
        <details style={replyBox}>
          <summary style={replySummary}>{t('detail.aiReply')}</summary>
          <pre style={replyPre}>{polishReply}</pre>
        </details>
      )}
    </div>
  );
}

// ── styles ─────────────────────────────────────────────────────────

const card: React.CSSProperties = {
  background: '#181825', border: '1px solid #313244', borderRadius: 8, padding: 12,
};

const label: React.CSSProperties = {
  color: '#a6adc8', fontSize: 12, fontWeight: 600, marginBottom: 4,
};

const hint: React.CSSProperties = {
  margin: '0 0 8px', color: '#6c7086', fontSize: 12, lineHeight: 1.5,
};

const resumeText: React.CSSProperties = {
  margin: 0, color: '#cdd6f4', fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap',
};

const capRow: React.CSSProperties = {
  display: 'flex', flexWrap: 'wrap', gap: 6,
};

const capChip: React.CSSProperties = {
  fontSize: 11, padding: '2px 8px', background: '#313244',
  borderRadius: 10, color: '#89dceb',
};

const textarea: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', minHeight: 120,
  background: '#11111b', border: '1px solid #45475a', borderRadius: 5,
  padding: '6px 10px', color: '#cdd6f4', fontSize: 13, lineHeight: 1.5,
  fontFamily: 'ui-monospace, Menlo, monospace', resize: 'vertical',
};

const promptFooterRow: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8,
};

const charCount: React.CSSProperties = {
  color: '#6c7086', fontSize: 11,
};

const actionRow: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
};

const primaryBtn: React.CSSProperties = {
  background: '#89b4fa', border: 'none', color: '#1e1e2e', fontWeight: 600,
  borderRadius: 5, padding: '6px 14px', cursor: 'pointer', fontSize: 12,
  whiteSpace: 'nowrap',
};

const secondaryBtn: React.CSSProperties = {
  background: 'transparent', border: '1px solid #45475a', color: '#89dceb',
  borderRadius: 5, padding: '6px 12px', cursor: 'pointer', fontSize: 12,
  whiteSpace: 'nowrap',
};

const offlineBanner: React.CSSProperties = {
  margin: 0, padding: '8px 12px', background: '#313244', borderRadius: 6,
  color: '#f9e2af', fontSize: 12,
};

const busyText: React.CSSProperties = {
  margin: '10px 0 0', color: '#89b4fa', fontSize: 12,
};

const noticeText: React.CSSProperties = {
  margin: 0, color: '#a6e3a1', fontSize: 12, fontWeight: 500,
};

const errorText: React.CSSProperties = {
  margin: 0, color: '#f38ba8', fontSize: 12, fontWeight: 500,
};

const replyBox: React.CSSProperties = {
  background: '#11111b', border: '1px solid #313244', borderRadius: 6, padding: '8px 12px',
};

const replySummary: React.CSSProperties = {
  cursor: 'pointer', color: '#a6adc8', fontSize: 12, fontWeight: 600,
};

const replyPre: React.CSSProperties = {
  margin: '8px 0 0', whiteSpace: 'pre-wrap', color: '#cdd6f4',
  fontSize: 12, lineHeight: 1.5, fontFamily: 'ui-monospace, Menlo, monospace',
};
