import { useState, useEffect, useMemo } from 'react';
import { api } from '../api/client.js';
import type { EngineInfo, HubMeta } from '../api/types.js';
import { useI18n } from '../i18n/index.js';
import { rememberCwd } from '../utils/cwdHistory.js';
import { filterAndSortEngines } from '../utils/enginePicker.js';
import { CwdPathInput } from './CwdPathInput.js';
import { DirectoryPickerModal } from './DirectoryPickerModal.js';
import { EngineIcon } from './EngineIcon.js';
import { SessionModeSelect } from './SessionModeSelect.js';
import { GATEWAY_PAIRING_UI } from '../utils/featureFlags.js';

const FALLBACK_ENGINES = [
  'codebuddy', 'claude-code', 'codex',
  'opencode', 'openclaw', 'cursor', 'hermes', 'kimi', 'zcode', 'deepseek-harness', 'qwen-code',
];

/** Survives modal unmount so closing without submit keeps the draft. */
interface AddInstanceDraft {
  label: string;
  engine: string;
  sessionMode: string;
  cwd: string;
  additionalDirectories: string[];
  host: string;
  baseUrl: string;
  tunnelServer: string;
  tunnelChannelId: string;
  tunnelSecret: string;
  showTunnel: boolean;
}

const EMPTY_DRAFT: AddInstanceDraft = {
  label: '',
  engine: '',
  sessionMode: '',
  cwd: '',
  additionalDirectories: [],
  host: '127.0.0.1',
  baseUrl: '',
  tunnelServer: '',
  tunnelChannelId: '',
  tunnelSecret: '',
  showTunnel: false,
};

let draft: AddInstanceDraft = { ...EMPTY_DRAFT };

function clearDraft() {
  draft = { ...EMPTY_DRAFT };
}

function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path || 'my-agent';
}

interface AddInstanceModalProps {
  onClose: () => void;
  onCreated: (result?: { started: boolean }) => void;
  onOpenEngineSettings: (engineId: string) => void;
  /** When set and present in the engine list, preselect this engine (per-mount only). */
  presetEngineId?: string | null;
}

export function AddInstanceModal({
  onClose,
  onCreated,
  onOpenEngineSettings,
  presetEngineId = null,
}: AddInstanceModalProps) {
  const { t } = useI18n();
  const [label, setLabel] = useState(draft.label);
  const [engine, setEngine] = useState(draft.engine);
  const [sessionMode, setSessionMode] = useState(draft.sessionMode);
  const [engineOptions, setEngineOptions] = useState<EngineInfo[]>([]);
  const [cwd, setCwd] = useState(draft.cwd);
  const [additionalDirectories, setAdditionalDirectories] = useState<string[]>(
    draft.additionalDirectories,
  );
  const [host, setHost] = useState(draft.host);
  const [baseUrl, setBaseUrl] = useState(draft.baseUrl);

  const [tunnelServer, setTunnelServer] = useState(draft.tunnelServer);
  const [tunnelChannelId, setTunnelChannelId] = useState(draft.tunnelChannelId);
  const [tunnelSecret, setTunnelSecret] = useState(draft.tunnelSecret);
  const [showAdvanced, setShowAdvanced] = useState(draft.showTunnel);

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hubMeta, setHubMeta] = useState<HubMeta | null>(null);
  const [showDirPicker, setShowDirPicker] = useState(false);
  const [dirPickerTarget, setDirPickerTarget] = useState<'cwd' | number>('cwd');
  const [seedPaths, setSeedPaths] = useState<string[]>([]);
  const [engineQuery, setEngineQuery] = useState('');

  // Keep draft in sync while editing; reopen restores these values.
  useEffect(() => {
    draft = {
      label,
      engine,
      sessionMode,
      cwd,
      additionalDirectories,
      host,
      baseUrl,
      tunnelServer,
      tunnelChannelId,
      tunnelSecret,
      showTunnel: showAdvanced,
    };
  }, [label, engine, sessionMode, cwd, additionalDirectories, host, baseUrl, tunnelServer, tunnelChannelId, tunnelSecret, showAdvanced]);

  useEffect(() => {
    api.engines.list()
      .then(({ engines }) => {
        setEngineOptions(engines);
        setEngine((current) => {
          if (presetEngineId && engines.some((e) => e.id === presetEngineId)) {
            return presetEngineId;
          }
          if (current && engines.some((e) => e.id === current)) return current;
          const firstAvailable = engines.find((e) => e.available !== false);
          if (firstAvailable) return firstAvailable.id;
          if (engines.length > 0) return engines[0]!.id;
          return current;
        });
      })
      .catch(() => { /* fallback engine ids below */ });
  }, []);

  const selectedEngine = engineOptions.find((e) => e.id === engine);
  const selectedUnavailable = selectedEngine?.available === false;
  const hasAvailableEngine = engineOptions.some((e) => e.available !== false);
  const sessionModes = selectedEngine?.sessionModes ?? [];
  const visibleEngines = useMemo(
    () => filterAndSortEngines(engineOptions, engineQuery),
    [engineOptions, engineQuery],
  );

  useEffect(() => {
    const modes = selectedEngine?.sessionModes ?? [];
    if (modes.length === 0) {
      setSessionMode('');
      return;
    }
    setSessionMode((current) =>
      modes.some((m) => m.id === current)
        ? current
        : (selectedEngine?.defaultSessionMode ?? modes[0]!.id),
    );
  }, [engine, selectedEngine]);

  useEffect(() => {
    api.instances.meta().then((meta) => {
      setHubMeta(meta);
    }).catch(() => { /* optional UX enhancement */ });
  }, []);

  useEffect(() => {
    api.instances.list()
      .then((instances) => {
        setSeedPaths(instances.map((i) => i.cwd).filter(Boolean));
      })
      .catch(() => { /* history seed is optional */ });
  }, []);

  // Prefill working directory with home when the field is empty.
  useEffect(() => {
    if (cwd) return;
    api.fs
      .browse()
      .then((r) => {
        setCwd(r.path);
        setLabel((prev) => prev || basename(r.path));
      })
      .catch(() => {
        /* user can browse manually */
      });
  }, [cwd]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedUnavailable) {
      setErr(selectedEngine?.unavailableReason ?? t('add.errEngineUnavailable'));
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const server = tunnelServer.trim();
      const channelId = tunnelChannelId.trim();
      const effectiveSecret = (tunnelSecret === '__use_cache__' ? '' : tunnelSecret).trim();
      const hasTunnel = Boolean(server && channelId && effectiveSecret);
      if ((server || channelId || effectiveSecret) && !hasTunnel) {
        setErr(t('add.errTunnelPartial'));
        setLoading(false);
        return;
      }
      const tunnel = hasTunnel
        ? { serverUrl: server, channelId, secret: effectiveSecret }
        : undefined;

      const resolvedBaseUrl = baseUrl.trim() || (tunnel ? `${tunnel.serverUrl}/proxy/${tunnel.channelId}` : '');
      const trimmedCwd = cwd.trim();
      if (!trimmedCwd) {
        setErr(t('add.errCwd'));
        setLoading(false);
        return;
      }

      const created = await api.instances.create({
        label: label.trim() || basename(trimmedCwd),
        engine,
        cwd: trimmedCwd,
        additionalDirectories: additionalDirectories
          .map((d) => d.trim())
          .filter((d) => d.length > 0 && d !== trimmedCwd),
        host,
        baseUrl: resolvedBaseUrl,
        tunnel,
        ...(sessionMode ? { sessionMode } : {}),
      });
      rememberCwd(cwd);
      clearDraft();
      if (created.startError) {
        setErr(t('add.errStartFailed', { error: created.startError }));
        setLoading(false);
        onCreated({ started: false });
        return;
      }
      onCreated({ started: true });
      onClose();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={overlay}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <h3 style={{ margin: 0, color: '#cdd6f4' }}>{t('add.title')}</h3>
          <button style={closeBtn} onClick={onClose}>✕</button>
        </div>

        <form onSubmit={(e) => void submit(e)} style={form}>
          <p style={{ color: '#6c7086', fontSize: 12, margin: '0 0 8px' }}>
            {t('add.hint')}
          </p>

          <label style={lbl}>{t('add.label')}</label>
          <input style={inp} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('add.labelPlaceholder')} />

          <div style={fieldHead}>
            <label style={{ ...lbl, margin: 0 }}>{t('add.engine')} <span style={req}>*</span></label>
            <button
              type="button"
              style={manageEngineBtn}
              onClick={() => onOpenEngineSettings(engine || engineOptions[0]?.id || 'codebuddy')}
            >
              {t('add.manageEngines')}
            </button>
          </div>
          {engineOptions.length > 0 ? (
            <div style={engineList} role="listbox" aria-label={t('add.engineAria')}>
              <input
                style={engineFilter}
                type="search"
                value={engineQuery}
                onChange={(e) => setEngineQuery(e.target.value)}
                placeholder={t('add.engineFilter')}
                aria-label={t('add.engineFilter')}
              />
              {visibleEngines.length === 0 && (
                <p style={{ color: '#6c7086', fontSize: 12, margin: '6px 4px' }}>
                  {t('add.engineNoMatch')}
                </p>
              )}
              {visibleEngines.map((e) => {
                const unavailable = e.available === false;
                const selected = engine === e.id;
                const title = e.builtin ? e.displayName : `${e.displayName} (${t('common.custom')})`;
                return (
                  <div
                    key={e.id}
                    role="option"
                    aria-selected={selected}
                    aria-disabled={unavailable}
                    style={{
                      ...engineRow,
                      ...(selected ? engineRowSelected : {}),
                      ...(unavailable ? engineRowUnavailable : {}),
                    }}
                    onClick={() => setEngine(e.id)}
                  >
                    <div style={engineRowMain}>
                      <EngineIcon engineId={e.id} size={24} title={title} />
                      <div style={engineRowText}>
                        <span style={{ color: unavailable ? '#a6adc8' : '#cdd6f4' }}>
                          {title}
                          {unavailable ? t('add.unavailableSuffix') : ''}
                        </span>
                        {unavailable && e.unavailableReason && (
                          <span style={engineReason}>{e.unavailableReason}</span>
                        )}
                      </div>
                    </div>
                    {unavailable && (
                      <button
                        type="button"
                        style={installLinkBtn}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          onOpenEngineSettings(e.id);
                        }}
                      >
                        {t('add.goConfigure')}
                      </button>
                    )}
                    <span style={engineRadio} aria-hidden="true">
                      {selected ? '●' : '○'}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <select
              style={inp}
              value={engine}
              onChange={(e) => setEngine(e.target.value)}
              required
            >
              {FALLBACK_ENGINES.map((id) => (
                <option key={id} value={id}>{id}</option>
              ))}
            </select>
          )}

          {selectedUnavailable && (
            <div style={unavailableBox}>
              <p style={{ margin: 0, color: '#f38ba8', fontSize: 13 }}>
                {selectedEngine?.unavailableReason ?? t('add.engineNotReady')}
              </p>
              <button
                type="button"
                style={installLinkBtn}
                onClick={() => onOpenEngineSettings(engine)}
              >
                {t('add.goEngineSettings')}
              </button>
            </div>
          )}

          {!hasAvailableEngine && engineOptions.length > 0 && (
            <p style={{ color: '#fab387', fontSize: 12, margin: '4px 0 0' }}>
              {t('add.noEngines')}
            </p>
          )}

          {sessionModes.length > 0 && (
            <>
              <label style={lbl}>{t('add.sessionMode')}</label>
              <SessionModeSelect
                modes={sessionModes}
                value={sessionMode}
                onChange={setSessionMode}
              />
            </>
          )}

          <label style={lbl}>{t('add.cwd')} <span style={req}>*</span></label>
          <CwdPathInput
            value={cwd}
            onChange={(path) => {
              setCwd(path);
              setLabel((prev) => (prev && prev !== basename(cwd) ? prev : basename(path)));
            }}
            placeholder={t('add.cwdPlaceholder')}
            required
            seedPaths={seedPaths}
            trailing={(
              <button
                type="button"
                style={browseBtn}
                onClick={() => {
                  setDirPickerTarget('cwd');
                  setShowDirPicker(true);
                }}
              >
                {t('common.browse')}
              </button>
            )}
          />

          <div style={fieldHead}>
            <label style={{ ...lbl, margin: 0 }}>{t('add.additionalDirs')}</label>
            <button
              type="button"
              style={manageEngineBtn}
              onClick={() => setAdditionalDirectories((prev) => [...prev, ''])}
            >
              {t('add.addDirectory')}
            </button>
          </div>
          <p style={{ color: '#6c7086', fontSize: 12, margin: '0 0 4px' }}>
            {t('add.additionalDirsHint')}
          </p>
          {additionalDirectories.map((dir, idx) => (
            <div key={idx} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <CwdPathInput
                value={dir}
                onChange={(path) => {
                  setAdditionalDirectories((prev) => {
                    const next = [...prev];
                    next[idx] = path;
                    return next;
                  });
                }}
                placeholder={t('add.additionalDirPlaceholder')}
                seedPaths={seedPaths}
                trailing={(
                  <button
                    type="button"
                    style={browseBtn}
                    onClick={() => {
                      setDirPickerTarget(idx);
                      setShowDirPicker(true);
                    }}
                  >
                    {t('common.browse')}
                  </button>
                )}
              />
              <button
                type="button"
                style={cancelBtn}
                onClick={() =>
                  setAdditionalDirectories((prev) => prev.filter((_, i) => i !== idx))
                }
              >
                {t('common.remove')}
              </button>
            </div>
          ))}

          <button
            type="button"
            style={tunnelToggle}
            onClick={() => setShowAdvanced((v) => !v)}
          >
            {showAdvanced ? '▼' : '▶'} {t('add.advanced')}
          </button>

          {showAdvanced && (
            <div style={tunnelBox}>
              <label style={lbl}>{t('add.bindHost')}</label>
              <select style={inp} value={host} onChange={(e) => setHost(e.target.value)}>
                <option value="127.0.0.1">{t('add.bindLoopback')}</option>
                <option value="0.0.0.0">{t('add.bindAll')}</option>
              </select>

              {GATEWAY_PAIRING_UI && (
                <>
              <label style={lbl}>{t('add.baseUrl')} <span style={{ color: '#6c7086', fontSize: 11 }}> ({t('common.optional')})</span></label>
              <input style={inp} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="wss://example.com" />

              <p style={tunnelNote}>
                {t('add.tunnelHint')}
              </p>
              <label style={lbl}>{t('add.serverUrl')}</label>
              <input
                style={inp}
                value={tunnelServer}
                onChange={(e) => setTunnelServer(e.target.value)}
                placeholder={hubMeta?.lastTunnelServerUrl ?? 'https://channel.example.com'}
              />
              <label style={lbl}>{t('add.channelId')}</label>
              <input
                style={inp}
                value={tunnelChannelId}
                onChange={(e) => setTunnelChannelId(e.target.value)}
                placeholder="ch_abc123"
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label style={lbl}>{t('add.secret')}</label>
                {hubMeta?.lastTunnelSecretHint && (
                  <button
                    type="button"
                    style={hintToggleBtn}
                    onClick={() => setTunnelSecret((v) => v ? '' : '__use_cache__')}
                    title={t('add.secretToggleTitle')}
                  >
                    {tunnelSecret === '__use_cache__'
                      ? t('add.secretUsing', { hint: hubMeta.lastTunnelSecretHint })
                      : t('add.secretCached', { hint: hubMeta.lastTunnelSecretHint })}
                  </button>
                )}
              </div>
              {tunnelSecret === '__use_cache__' ? (
                <div style={cachedValueDisplay}>
                  <span style={{ color: '#a6e3a1', fontSize: 13 }}>{hubMeta?.lastTunnelSecretHint}</span>
                  <span style={{ color: '#6c7086', fontSize: 12, marginLeft: 8 }}>{t('add.secretCachedHint')}</span>
                </div>
              ) : (
                <input
                  style={inp}
                  type="password"
                  value={tunnelSecret}
                  onChange={(e) => setTunnelSecret(e.target.value)}
                  placeholder={hubMeta?.lastTunnelSecretHint ? t('add.secretPlaceholderOverride') : t('add.secretPlaceholder')}
                />
              )}
                </>
              )}
            </div>
          )}

          {err && <p style={{ color: '#f38ba8', margin: '4px 0' }}>{err}</p>}

          <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
            <button type="submit" style={submitBtn} disabled={loading || selectedUnavailable || !engine}>
              {loading ? t('add.submitting') : t('add.submit')}
            </button>
            <button type="button" style={cancelBtn} onClick={onClose}>{t('common.cancel')}</button>
          </div>
        </form>
      </div>

      {showDirPicker && (
        <DirectoryPickerModal
          initialPath={
            dirPickerTarget === 'cwd'
              ? cwd
              : (additionalDirectories[dirPickerTarget] || cwd)
          }
          onSelect={(path) => {
            if (dirPickerTarget === 'cwd') {
              setCwd(path);
              setLabel((prev) => (prev && prev !== basename(cwd) ? prev : basename(path)));
            } else {
              setAdditionalDirectories((prev) => {
                const next = [...prev];
                next[dirPickerTarget] = path;
                return next;
              });
            }
            setShowDirPicker(false);
          }}
          onClose={() => setShowDirPicker(false)}
        />
      )}
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0,
  background: 'rgba(0,0,0,0.6)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 100,
};
const modal: React.CSSProperties = {
  background: '#1e1e2e', border: '1px solid #45475a',
  borderRadius: 10, width: '90%', maxWidth: 480,
  maxHeight: '90vh', overflowY: 'auto',
};
const header: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  padding: '14px 20px', borderBottom: '1px solid #313244',
};
const closeBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', color: '#a6adc8', fontSize: 18, cursor: 'pointer',
};
const form: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 8, padding: 20,
};
const lbl: React.CSSProperties = { color: '#a6adc8', fontSize: 13 };
const fieldHead: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
};
const manageEngineBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', color: '#89b4fa',
  cursor: 'pointer', fontSize: 12, padding: 0, whiteSpace: 'nowrap',
};
const req: React.CSSProperties = { color: '#f38ba8' };
const inp: React.CSSProperties = {
  background: '#11111b', border: '1px solid #45475a', borderRadius: 5,
  color: '#cdd6f4', padding: '6px 10px', fontSize: 14, outline: 'none',
};
const browseBtn: React.CSSProperties = {
  background: 'transparent', border: '1px solid #45475a', color: '#89b4fa',
  borderRadius: 5, padding: '6px 12px', cursor: 'pointer', fontSize: 13,
  whiteSpace: 'nowrap', flexShrink: 0,
};
const submitBtn: React.CSSProperties = {
  background: '#89b4fa', color: '#11111b', border: 'none',
  borderRadius: 6, padding: '7px 18px', cursor: 'pointer', fontWeight: 600,
};
const cancelBtn: React.CSSProperties = {
  background: 'transparent', border: '1px solid #45475a', color: '#a6adc8',
  borderRadius: 6, padding: '7px 18px', cursor: 'pointer',
};
const tunnelToggle: React.CSSProperties = {
  background: 'transparent', border: '1px solid #45475a', color: '#a6adc8',
  borderRadius: 5, padding: '5px 10px', cursor: 'pointer', fontSize: 13,
  textAlign: 'left', marginTop: 4,
};
const tunnelBox: React.CSSProperties = {
  background: '#11111b', border: '1px solid #313244', borderRadius: 6,
  padding: 12, display: 'flex', flexDirection: 'column', gap: 6,
};
const tunnelNote: React.CSSProperties = {
  color: '#6c7086', fontSize: 12, margin: '0 0 4px',
};
const hintToggleBtn: React.CSSProperties = {
  background: 'transparent', border: '1px solid #313244', color: '#89b4fa',
  borderRadius: 4, padding: '2px 8px', fontSize: 11, cursor: 'pointer',
  fontFamily: 'monospace', whiteSpace: 'nowrap',
};
const cachedValueDisplay: React.CSSProperties = {
  background: '#11111b', border: '1px solid #313244', borderRadius: 5,
  padding: '6px 10px', fontSize: 13, fontFamily: 'monospace',
  display: 'flex', alignItems: 'center',
};
const unavailableBox: React.CSSProperties = {
  background: '#45263233', border: '1px solid #f38ba866', borderRadius: 6,
  padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8,
};
const installLinkBtn: React.CSSProperties = {
  flexShrink: 0, alignSelf: 'center', background: 'transparent', border: '1px solid #89b4fa',
  color: '#89b4fa', borderRadius: 5, padding: '4px 10px', cursor: 'pointer', fontSize: 12,
  whiteSpace: 'nowrap',
};
const engineList: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 6,
  maxHeight: 220, overflowY: 'auto',
  background: '#11111b', border: '1px solid #45475a', borderRadius: 6, padding: 6,
};
const engineFilter: React.CSSProperties = {
  background: '#181825', border: '1px solid #45475a', borderRadius: 5,
  color: '#cdd6f4', padding: '6px 10px', fontSize: 13, outline: 'none',
  position: 'sticky', top: 0, zIndex: 1,
};
const engineRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
  padding: '8px 10px', borderRadius: 5, cursor: 'pointer',
  border: '1px solid transparent',
};
const engineRowSelected: React.CSSProperties = {
  background: '#313244', border: '1px solid #89b4fa66',
};
const engineRowUnavailable: React.CSSProperties = {
  opacity: 0.92,
};
const engineRowMain: React.CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: 8, minWidth: 0, flex: 1,
};
const engineRadio: React.CSSProperties = {
  color: '#89b4fa', fontSize: 12, lineHeight: '18px', flexShrink: 0,
};
const engineRowText: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0,
  fontSize: 13, lineHeight: 1.35,
};
const engineReason: React.CSSProperties = {
  color: '#6c7086', fontSize: 11, lineHeight: 1.35,
  overflow: 'hidden', textOverflow: 'ellipsis',
  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
};
