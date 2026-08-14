import type { BusyFilter } from '../utils/instanceFilters.js';
import { useI18n } from '../i18n/index.js';

export interface InstanceListFilterState {
  search: string;
  busy: BusyFilter;
  engine: string;
}

interface InstanceListFiltersProps {
  value: InstanceListFilterState;
  engines: string[];
  onChange: (next: InstanceListFilterState) => void;
  shown: number;
  total: number;
  runningCount?: number;
  restartAllBusy?: boolean;
  restartAllDisabled?: boolean;
  onRestartAll?: () => void;
  onAddInstance?: () => void;
}

export function InstanceListFilters({
  value,
  engines,
  onChange,
  shown,
  total,
  runningCount = 0,
  restartAllBusy = false,
  restartAllDisabled = false,
  onRestartAll,
  onAddInstance,
}: InstanceListFiltersProps) {
  const { t } = useI18n();
  const hasActiveFilter =
    value.search.trim().length > 0 || value.busy !== 'all' || value.engine !== 'all';

  return (
    <div style={bar}>
      <input
        style={input}
        type="search"
        placeholder={t('filters.search')}
        value={value.search}
        onChange={(e) => onChange({ ...value, search: e.target.value })}
      />
      <select
        style={select}
        value={value.busy}
        onChange={(e) => onChange({ ...value, busy: e.target.value as BusyFilter })}
      >
        <option value="all">{t('filters.busyAll')}</option>
        <option value="idle">{t('filters.busyIdle')}</option>
        <option value="busy">{t('filters.busyBusy')}</option>
        <option value="overloaded">{t('filters.busyOverloaded')}</option>
        <option value="unknown">{t('filters.busyUnknown')}</option>
      </select>
      <select
        style={select}
        value={value.engine}
        onChange={(e) => onChange({ ...value, engine: e.target.value })}
      >
        <option value="all">{t('filters.engineAll')}</option>
        {engines.map((engine) => (
          <option key={engine} value={engine}>{engine}</option>
        ))}
      </select>
      <span style={count}>
        {hasActiveFilter ? t('filters.shown', { shown, total }) : t('filters.total', { total })}
      </span>
      {hasActiveFilter && (
        <button
          style={clearBtn}
          type="button"
          onClick={() => onChange({ search: '', busy: 'all', engine: 'all' })}
        >
          {t('instances.clearFilters')}
        </button>
      )}
      <div style={actions}>
        {runningCount > 0 && onRestartAll && (
          <button
            style={restartAllBtn}
            type="button"
            disabled={restartAllBusy || restartAllDisabled}
            onClick={onRestartAll}
          >
            {restartAllBusy ? t('instances.restarting') : t('instances.restartAll')}
          </button>
        )}
        {onAddInstance && (
          <button style={addBtn} type="button" onClick={onAddInstance}>
            {t('instances.addPlus')}
          </button>
        )}
      </div>
    </div>
  );
}

const bar: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 10,
  marginBottom: 16,
  padding: '12px 14px',
  background: '#1e1e2e',
  border: '1px solid #313244',
  borderRadius: 8,
};

const input: React.CSSProperties = {
  flex: '1 1 180px',
  minWidth: 140,
  padding: '8px 10px',
  background: '#181825',
  border: '1px solid #313244',
  borderRadius: 6,
  color: '#cdd6f4',
  fontSize: 14,
};

const select: React.CSSProperties = {
  padding: '8px 10px',
  background: '#181825',
  border: '1px solid #313244',
  borderRadius: 6,
  color: '#cdd6f4',
  fontSize: 13,
};

const count: React.CSSProperties = {
  color: '#6c7086',
  fontSize: 13,
};

const clearBtn: React.CSSProperties = {
  background: 'transparent',
  color: '#a6adc8',
  border: '1px solid #45475a',
  borderRadius: 6,
  padding: '6px 12px',
  cursor: 'pointer',
  fontSize: 13,
};

const actions: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  marginLeft: 'auto',
  alignItems: 'center',
};

const restartAllBtn: React.CSSProperties = {
  background: 'transparent',
  color: '#f9e2af',
  border: '1px solid #f9e2af',
  borderRadius: 6,
  padding: '8px 14px',
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: 13,
};

const addBtn: React.CSSProperties = {
  background: '#89b4fa',
  color: '#11111b',
  border: 'none',
  borderRadius: 6,
  padding: '8px 14px',
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: 13,
};
