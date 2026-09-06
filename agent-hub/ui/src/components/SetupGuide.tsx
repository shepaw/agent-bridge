import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import type { EngineInfo } from '../api/types.js';
import { summarizeEngines } from '../utils/engineScan.js';
import { SHEPAW_APP_DOWNLOAD_URL } from '../utils/appLinks.js';
import { useI18n } from '../i18n/index.js';

/**
 * First-install setup guide card, rendered above the page that owns the
 * current step:
 *   - step 'engines': above Engine management — live scan summary + "create
 *     instance" CTA. Polls /api/engines every 5 s so counts refresh as the
 *     user installs/enables engines further down the page.
 *   - step 'pair':     above the scan-to-pair page — static scan instructions
 *     plus a collapsible "get the app" block. PeerPairingPanel below already
 *     mints the QR.
 *
 * The three mini-steps (engine → instance → phone) highlight the current one.
 */
export function SetupGuide({
  step,
  onOpenCreate,
  onSkip,
}: {
  step: 'engines' | 'pair';
  /** engines step only: open the Create Instance modal. */
  onOpenCreate?: () => void;
  /** both steps: skip / finish the guide (App persists the stage). */
  onSkip: () => void;
}) {
  const { t } = useI18n();
  const [engines, setEngines] = useState<EngineInfo[] | null>(null);

  useEffect(() => {
    if (step !== 'engines') return;
    let cancelled = false;
    const load = async () => {
      try {
        const { engines: list } = await api.engines.list();
        if (!cancelled) setEngines(list);
      } catch {
        /* scan failure leaves the counts hidden; the page below still lists */
      }
    };
    void load();
    const id = setInterval(() => void load(), 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [step]);

  const stepLabels = [t('setup.step1Label'), t('setup.step2Label'), t('setup.step3Label')];
  const activeStep = step === 'engines' ? 0 : 2;
  const doneSteps = step === 'engines' ? 0 : 2;

  const summary = engines ? summarizeEngines(engines) : null;

  return (
    <div style={card}>
      <div style={headRow}>
        <div style={steps}>
          {stepLabels.map((label, i) => (
            <span
              key={label}
              style={stepItem(
                i < doneSteps ? 'done' : i === activeStep ? 'active' : 'todo',
              )}
            >
              {label}
            </span>
          ))}
        </div>
        <span style={pill}>{t('setup.title')}</span>
      </div>

      {step === 'engines' ? (
        <div style={body}>
          <h4 style={heading}>{t('setup.enginesTitle')}</h4>
          <p style={lead}>{t('setup.enginesLead')}</p>

          {summary && (
            <p style={counts}>
              <span style={{ color: '#a6e3a1' }}>
                {t('setup.enginesCount', { ready: summary.ready, total: summary.total })}
              </span>
              {summary.needSetup.length > 0 && (
                <>
                  {' · '}
                  <span style={{ color: '#fab387' }}>
                    {t('setup.enginesNeedSetup', { count: summary.needSetup.length })}
                  </span>
                </>
              )}
            </p>
          )}

          <div style={actions}>
            {onOpenCreate && (
              <button type="button" style={primaryBtn} onClick={onOpenCreate}>
                {t('setup.createInstance')}
              </button>
            )}
            <button type="button" style={secondaryBtn} onClick={onSkip}>
              {t('setup.skip')}
            </button>
          </div>
        </div>
      ) : (
        <div style={body}>
          <h4 style={heading}>{t('setup.pairTitle')}</h4>
          <p style={lead}>{t('setup.pairLead')}</p>

          <details style={appInstall}>
            <summary style={appInstallSummary}>{t('setup.installAppTitle')}</summary>
            <p style={appInstallBody}>
              {t('setup.installAppBody', { url: SHEPAW_APP_DOWNLOAD_URL })}
              <a href={SHEPAW_APP_DOWNLOAD_URL} target="_blank" rel="noreferrer" style={docLink}>
                {' '}
                {SHEPAW_APP_DOWNLOAD_URL} ↗
              </a>
            </p>
          </details>

          <div style={actions}>
            <button type="button" style={primaryBtn} onClick={onSkip}>
              {t('setup.done')}
            </button>
            <button type="button" style={secondaryBtn} onClick={onSkip}>
              {t('setup.skip')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────────

const card: React.CSSProperties = {
  background: '#1e1e2e',
  border: '1px solid #45475a',
  borderRadius: 10,
  padding: '16px 20px',
  marginBottom: 16,
};
const headRow: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap',
  marginBottom: 12,
};
const steps: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
};
const stepItem = (state: 'done' | 'active' | 'todo'): React.CSSProperties => {
  const base: React.CSSProperties = { fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' };
  if (state === 'done') return { ...base, color: '#a6e3a1' };
  if (state === 'active') return { ...base, color: '#89b4fa' };
  return { ...base, color: '#6c7086', fontWeight: 400 };
};
const pill: React.CSSProperties = {
  background: '#313244',
  color: '#a6adc8',
  borderRadius: 999,
  padding: '2px 10px',
  fontSize: 11,
  fontWeight: 600,
};
const body: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8 };
const heading: React.CSSProperties = { margin: 0, color: '#cdd6f4', fontSize: 15 };
const lead: React.CSSProperties = { margin: 0, color: '#a6adc8', fontSize: 13, lineHeight: 1.5 };
const counts: React.CSSProperties = { margin: 0, fontSize: 13, fontWeight: 600 };
const actions: React.CSSProperties = { display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' };
const primaryBtn: React.CSSProperties = {
  background: '#89b4fa',
  color: '#11111b',
  border: 'none',
  borderRadius: 6,
  padding: '8px 18px',
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: 14,
};
const secondaryBtn: React.CSSProperties = {
  background: 'transparent',
  color: '#cdd6f4',
  border: '1px solid #45475a',
  borderRadius: 6,
  padding: '8px 18px',
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: 14,
};
const appInstall: React.CSSProperties = {
  background: '#181825',
  border: '1px solid #313244',
  borderRadius: 6,
  padding: '8px 12px',
};
const appInstallSummary: React.CSSProperties = {
  color: '#a6adc8',
  fontSize: 13,
  cursor: 'pointer',
};
const appInstallBody: React.CSSProperties = {
  margin: '8px 0 0',
  color: '#6c7086',
  fontSize: 12,
  lineHeight: 1.5,
  wordBreak: 'break-all',
};
const docLink: React.CSSProperties = { color: '#89b4fa', fontSize: 12, textDecoration: 'none' };
