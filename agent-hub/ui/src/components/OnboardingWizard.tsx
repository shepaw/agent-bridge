/**
 * First-run wizard (engine → cwd → start → per-instance enroll QR).
 *
 * The dashboard first-run path is now Add Instance + 扫码配对 (Peer is
 * started by `shepaw-hub web`). This wizard remains for the explicit
 * per-instance enroll flow if it is re-enabled.
 */

import { useEffect, useMemo, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { api } from '../api/client.js';
import type { EngineInfo, EnrollToken, Instance } from '../api/types.js';
import { DirectoryPickerModal } from './DirectoryPickerModal.js';
import { useI18n } from '../i18n/index.js';

type Step = 'engine' | 'cwd' | 'launch' | 'pair';

interface OnboardingWizardProps {
  onClose: () => void;
  onFinished: (instanceId: string) => void;
  onOpenEngineSettings: (engineId: string) => void;
}

function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path || 'my-agent';
}

export function OnboardingWizard({
  onClose,
  onFinished,
  onOpenEngineSettings,
}: OnboardingWizardProps) {
  const { t } = useI18n();
  const [step, setStep] = useState<Step>('engine');
  const [engines, setEngines] = useState<EngineInfo[]>([]);
  const [enginesLoading, setEnginesLoading] = useState(true);
  const [engine, setEngine] = useState('');
  const [cwd, setCwd] = useState('');
  const [label, setLabel] = useState('');
  const [showDirPicker, setShowDirPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [statusLine, setStatusLine] = useState('');
  const [created, setCreated] = useState<Instance | null>(null);
  const [token, setToken] = useState<EnrollToken | null>(null);

  useEffect(() => {
    setEnginesLoading(true);
    api.engines
      .list()
      .then(({ engines: list }) => {
        setEngines(list);
        setEngine((current) => {
          if (current && list.some((e) => e.id === current)) return current;
          const firstOk = list.find((e) => e.available !== false);
          return firstOk?.id ?? list[0]?.id ?? current;
        });
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setEnginesLoading(false));
  }, []);

  // Prefill cwd with home via browse() when entering the cwd step.
  useEffect(() => {
    if (step !== 'cwd' || cwd) return;
    api.fs
      .browse()
      .then((r) => {
        setCwd(r.path);
        setLabel((prev) => prev || basename(r.path));
      })
      .catch(() => {
        /* user can browse manually */
      });
  }, [step, cwd]);

  const selected = engines.find((e) => e.id === engine);
  const selectedUnavailable = selected?.available === false;
  const hasAvailable = engines.some((e) => e.available !== false);

  const stepIndex = useMemo(() => {
    const order: Step[] = ['engine', 'cwd', 'launch', 'pair'];
    return order.indexOf(step);
  }, [step]);

  const goCwd = () => {
    setErr(null);
    if (!engine) {
      setErr(t('add.errPickEngine'));
      return;
    }
    if (selectedUnavailable) {
      setErr(selected?.unavailableReason ?? t('add.errEngineUnavailable'));
      return;
    }
    setStep('cwd');
  };

  const launch = async () => {
    setErr(null);
    const trimmedCwd = cwd.trim();
    if (!trimmedCwd) {
      setErr(t('add.errCwd'));
      return;
    }
    setStep('launch');
    setBusy(true);
    setStatusLine(t('wizard.creatingInstance'));
    try {
      const instance = await api.instances.create({
        engine,
        cwd: trimmedCwd,
        label: label.trim() || basename(trimmedCwd),
        host: '0.0.0.0',
        start: false,
      });
      setCreated(instance);
      setStatusLine(t('wizard.createdStarting', { id: instance.id.slice(0, 8) }));
      await api.instances.start(instance.id);
      setStatusLine(t('wizard.gatewayMinting'));
      const enrollToken = await api.enroll.mint(instance.id, {
        ttlMinutes: 10,
        label: 'Dashboard onboarding',
      });
      setToken(enrollToken);
      setStep('pair');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      // Stay on launch step so the user can retry / go back.
    } finally {
      setBusy(false);
    }
  };

  const finish = () => {
    if (created) onFinished(created.id);
    else onClose();
  };

  return (
    <div style={overlay} onClick={busy ? undefined : onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <div>
            <h3 style={{ margin: 0, color: '#cdd6f4' }}>{t('wizard.title')}</h3>
            <p style={{ margin: '4px 0 0', color: '#a6adc8', fontSize: 13 }}>
              {t('wizard.subtitle')}
            </p>
          </div>
          <button style={closeBtn} type="button" disabled={busy} onClick={onClose}>
            ✕
          </button>
        </div>

        <div style={stepsBar}>
          {([
            t('wizard.stepEngine'),
            t('wizard.stepCwd'),
            t('wizard.stepLaunch'),
            t('wizard.stepPair'),
          ] as const).map((name, i) => (
            <div
              key={name}
              style={{
                ...stepChip,
                ...(i === stepIndex ? stepChipActive : null),
                ...(i < stepIndex ? stepChipDone : null),
              }}
            >
              {i + 1}. {name}
            </div>
          ))}
        </div>

        <div style={body}>
          {step === 'engine' && (
            <>
              <p style={hint}>
                {t('wizard.engineHint')}
              </p>
              {enginesLoading && <p style={hint}>{t('wizard.detectingEngines')}</p>}
              {!enginesLoading && engines.length === 0 && (
                <p style={{ color: '#f38ba8' }}>{t('wizard.loadEnginesFail')}</p>
              )}
              {!enginesLoading && !hasAvailable && engines.length > 0 && (
                <div style={warnBox}>
                  {t('wizard.noEnginesWarn')}
                </div>
              )}
              <div style={engineList} role="listbox" aria-label="Engine">
                {engines.map((e) => {
                  const unavailable = e.available === false;
                  const isSelected = engine === e.id;
                  return (
                    <button
                      key={e.id}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      style={{
                        ...engineItem,
                        ...(isSelected ? engineItemSelected : null),
                        ...(unavailable ? engineItemUnavailable : null),
                      }}
                      onClick={() => setEngine(e.id)}
                    >
                      <span style={{ fontWeight: 600 }}>{e.displayName}</span>
                      <span style={{ color: '#6c7086', fontSize: 12 }}>{e.id}</span>
                      <span style={{ marginLeft: 'auto', fontSize: 12, color: unavailable ? '#f38ba8' : '#a6e3a1' }}>
                        {unavailable ? (e.unavailableReason ?? t('common.unavailable')) : t('wizard.ready')}
                      </span>
                    </button>
                  );
                })}
              </div>
              {selectedUnavailable && selected && (
                <div style={warnBox}>
                  {selected.unavailableReason ?? t('wizard.engineUnavailable')}
                  <button
                    type="button"
                    style={linkBtn}
                    onClick={() => onOpenEngineSettings(selected.id)}
                  >
                    {t('wizard.openEngineSettings')}
                  </button>
                </div>
              )}
            </>
          )}

          {step === 'cwd' && (
            <>
              <p style={hint}>{t('wizard.cwdHint')}</p>
              <label style={lbl}>{t('add.cwd')}</label>
              <div style={cwdRow}>
                <input
                  style={{ ...inp, flex: 1 }}
                  value={cwd}
                  onChange={(e) => {
                    setCwd(e.target.value);
                    if (!label) setLabel(basename(e.target.value));
                  }}
                  placeholder="/path/to/project"
                />
                <button type="button" style={browseBtn} onClick={() => setShowDirPicker(true)}>
                  {t('common.browse')}
                </button>
              </div>
              <label style={lbl}>{t('wizard.displayNameOptional')}</label>
              <input
                style={inp}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={basename(cwd) || t('add.labelPlaceholder')}
              />
              <p style={{ ...hint, marginTop: 8 }}>
                {t('wizard.bindHint')}
              </p>
            </>
          )}

          {step === 'launch' && (
            <>
              <p style={hint}>{statusLine || t('wizard.preparing')}</p>
              {busy && <div style={spinnerRow}>{t('wizard.pleaseWait')}</div>}
              {err && (
                <p style={{ color: '#f38ba8' }}>
                  {err}
                </p>
              )}
            </>
          )}

          {step === 'pair' && token && (
            <>
              <p style={hint}>
                {t('wizard.pairHint')}
              </p>
              {token.qrPayload && (
                <div style={qrWrap}>
                  <QRCodeSVG
                    value={token.qrPayload}
                    size={200}
                    bgColor="#1e1e2e"
                    fgColor="#cdd6f4"
                    level="M"
                  />
                </div>
              )}
              <div style={tokenInfo}>
                <p style={infoRow}>
                  <span style={infoLabel}>{t('detail.pairCode')}</span>
                  <code style={codeBox}>{token.display ?? token.code}</code>
                </p>
                <p style={infoRow}>
                  <span style={infoLabel}>{t('wizard.expiresAt')}</span>
                  <span>{new Date(token.expiresAt).toLocaleString()}</span>
                </p>
                {token.pairUrl && (
                  <p style={infoRow}>
                    <span style={infoLabel}>{t('enroll.url')}</span>
                    <code style={{ ...codeBox, fontSize: 11, wordBreak: 'break-all' }}>{token.pairUrl}</code>
                  </p>
                )}
                {created && (
                  <p style={{ ...hint, marginTop: 8 }}>
                    {t('wizard.instanceSummary', {
                      label: created.label,
                      engine: created.engine,
                      host: created.host,
                      port: created.port,
                    })}
                  </p>
                )}
              </div>
            </>
          )}

          {err && step !== 'launch' && <p style={{ color: '#f38ba8', margin: '8px 0 0' }}>{err}</p>}
        </div>

        <div style={footer}>
          {step === 'engine' && (
            <>
              <button type="button" style={cancelBtn} onClick={onClose}>
                {t('wizard.later')}
              </button>
              <button
                type="button"
                style={primaryBtn}
                disabled={!engine || enginesLoading}
                onClick={goCwd}
              >
                {t('wizard.next')}
              </button>
            </>
          )}
          {step === 'cwd' && (
            <>
              <button type="button" style={cancelBtn} onClick={() => setStep('engine')}>
                {t('wizard.back')}
              </button>
              <button type="button" style={primaryBtn} disabled={busy} onClick={() => void launch()}>
                {t('wizard.createAndStart')}
              </button>
            </>
          )}
          {step === 'launch' && err && !busy && (
            <>
              <button type="button" style={cancelBtn} onClick={() => setStep('cwd')}>
                {t('wizard.backEdit')}
              </button>
              <button type="button" style={primaryBtn} onClick={() => void launch()}>
                {t('common.retry')}
              </button>
            </>
          )}
          {step === 'pair' && (
            <button type="button" style={primaryBtn} onClick={finish}>
              {t('wizard.finish')}
            </button>
          )}
        </div>
      </div>

      {showDirPicker && (
        <DirectoryPickerModal
          initialPath={cwd || undefined}
          onSelect={(path) => {
            setCwd(path);
            setLabel((prev) => prev || basename(path));
            setShowDirPicker(false);
          }}
          onClose={() => setShowDirPicker(false)}
        />
      )}
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.6)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 100,
};
const modal: React.CSSProperties = {
  background: '#1e1e2e',
  border: '1px solid #45475a',
  borderRadius: 10,
  width: '92%',
  maxWidth: 560,
  maxHeight: '92vh',
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
};
const header: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  padding: '16px 20px',
  borderBottom: '1px solid #313244',
  gap: 12,
};
const closeBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#a6adc8',
  fontSize: 18,
  cursor: 'pointer',
};
const stepsBar: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  padding: '12px 20px 0',
  flexWrap: 'wrap',
};
const stepChip: React.CSSProperties = {
  fontSize: 12,
  color: '#6c7086',
  border: '1px solid #313244',
  borderRadius: 999,
  padding: '4px 10px',
};
const stepChipActive: React.CSSProperties = {
  color: '#11111b',
  background: '#89b4fa',
  borderColor: '#89b4fa',
  fontWeight: 600,
};
const stepChipDone: React.CSSProperties = {
  color: '#a6e3a1',
  borderColor: '#a6e3a166',
};
const body: React.CSSProperties = {
  padding: 20,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  flex: 1,
};
const footer: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 10,
  padding: '12px 20px 16px',
  borderTop: '1px solid #313244',
};
const hint: React.CSSProperties = { color: '#a6adc8', fontSize: 13, margin: 0 };
const lbl: React.CSSProperties = { color: '#a6adc8', fontSize: 13 };
const inp: React.CSSProperties = {
  background: '#11111b',
  border: '1px solid #45475a',
  borderRadius: 5,
  color: '#cdd6f4',
  padding: '6px 10px',
  fontSize: 14,
  outline: 'none',
};
const cwdRow: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'stretch' };
const browseBtn: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid #45475a',
  color: '#89b4fa',
  borderRadius: 5,
  padding: '6px 12px',
  cursor: 'pointer',
  fontSize: 13,
  whiteSpace: 'nowrap',
};
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
const cancelBtn: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid #45475a',
  color: '#a6adc8',
  borderRadius: 6,
  padding: '8px 18px',
  cursor: 'pointer',
};
const engineList: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  maxHeight: 280,
  overflowY: 'auto',
};
const engineItem: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  textAlign: 'left',
  background: '#11111b',
  border: '1px solid #313244',
  borderRadius: 8,
  padding: '10px 12px',
  color: '#cdd6f4',
  cursor: 'pointer',
};
const engineItemSelected: React.CSSProperties = {
  borderColor: '#89b4fa',
  boxShadow: '0 0 0 1px #89b4fa55',
};
const engineItemUnavailable: React.CSSProperties = {
  opacity: 0.85,
};
const warnBox: React.CSSProperties = {
  background: '#45263233',
  border: '1px solid #f38ba866',
  borderRadius: 6,
  padding: '10px 12px',
  color: '#f2cdcd',
  fontSize: 13,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};
const linkBtn: React.CSSProperties = {
  alignSelf: 'flex-start',
  background: 'transparent',
  border: '1px solid #f38ba866',
  color: '#89b4fa',
  borderRadius: 5,
  padding: '4px 10px',
  cursor: 'pointer',
  fontSize: 12,
};
const spinnerRow: React.CSSProperties = { color: '#89b4fa', fontSize: 13 };
const qrWrap: React.CSSProperties = {
  alignSelf: 'center',
  background: '#1e1e2e',
  padding: 12,
  borderRadius: 8,
  border: '1px solid #313244',
};
const tokenInfo: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 };
const infoRow: React.CSSProperties = {
  display: 'flex',
  gap: 12,
  margin: 0,
  fontSize: 13,
  color: '#cdd6f4',
  alignItems: 'flex-start',
};
const infoLabel: React.CSSProperties = {
  color: '#6c7086',
  minWidth: 64,
  flexShrink: 0,
};
const codeBox: React.CSSProperties = {
  background: '#11111b',
  border: '1px solid #313244',
  borderRadius: 4,
  padding: '2px 8px',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 13,
};
