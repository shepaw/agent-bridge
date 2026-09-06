import { useEngines } from '../hooks/useEngines.js';
import { EngineRow } from './EngineManager.js';
import { useI18n } from '../i18n/index.js';

/**
 * Per-engine configuration page (`#engine/<id>`). Renders a single expanded
 * EngineRow so an engine can be installed/enabled, disabled, given default
 * environment variables, and (for custom engines) renamed or deleted without
 * leaving the engine.
 */
export function EngineConfigPage({
  engineId,
  onBack,
}: {
  engineId: string;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const { engines, loading, error, reload } = useEngines();
  const engine = engines?.find((e) => e.id === engineId);

  return (
    <div style={card}>
      <button type="button" style={backBtn} onClick={onBack}>
        ← {t('hub.backToAgents')}
      </button>

      {loading && engines === null ? (
        <p style={hint}>{t('common.loading')}</p>
      ) : engine ? (
        <EngineRow engine={engine} onChanged={() => void reload()} initialOpen embedded />
      ) : (
        <>
          <p style={{ color: '#cdd6f4', fontSize: 15, fontWeight: 600, margin: '0 0 6px' }}>
            {t('hub.engineGone')}
          </p>
          <p style={hint}>
            <code style={{ color: '#f9e2af' }}>{engineId}</code>
          </p>
          <button type="button" style={backBtn} onClick={onBack}>
            ← {t('hub.backToAgents')}
          </button>
          {error && <p style={{ color: '#f38ba8', fontSize: 13 }}>{error}</p>}
        </>
      )}
    </div>
  );
}

const card: React.CSSProperties = {
  background: '#1e1e2e',
  border: '1px solid #313244',
  borderRadius: 10,
  padding: '20px 24px',
};
const backBtn: React.CSSProperties = {
  display: 'inline-block',
  background: 'transparent',
  border: '1px solid #45475a',
  color: '#89b4fa',
  borderRadius: 6,
  padding: '7px 14px',
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: 13,
  marginBottom: 16,
};
const hint: React.CSSProperties = { color: '#a6adc8', fontSize: 13, margin: '0 0 10px' };
