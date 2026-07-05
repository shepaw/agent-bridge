import type { BusyFilter } from '../utils/instanceFilters.js';

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
}

export function InstanceListFilters({ value, engines, onChange, shown, total }: InstanceListFiltersProps) {
  const hasActiveFilter =
    value.search.trim().length > 0 || value.busy !== 'all' || value.engine !== 'all';

  return (
    <div style={bar}>
      <input
        style={input}
        type="search"
        placeholder="按标题搜索…"
        value={value.search}
        onChange={(e) => onChange({ ...value, search: e.target.value })}
      />
      <select
        style={select}
        value={value.busy}
        onChange={(e) => onChange({ ...value, busy: e.target.value as BusyFilter })}
      >
        <option value="all">全部负载状态</option>
        <option value="idle">空闲</option>
        <option value="busy">繁忙</option>
        <option value="overloaded">高负载</option>
        <option value="unknown">未探测</option>
      </select>
      <select
        style={select}
        value={value.engine}
        onChange={(e) => onChange({ ...value, engine: e.target.value })}
      >
        <option value="all">全部引擎</option>
        {engines.map((engine) => (
          <option key={engine} value={engine}>{engine}</option>
        ))}
      </select>
      <span style={count}>
        {hasActiveFilter ? `显示 ${shown} / ${total}` : `${total} 个实例`}
      </span>
      {hasActiveFilter && (
        <button
          style={clearBtn}
          type="button"
          onClick={() => onChange({ search: '', busy: 'all', engine: 'all' })}
        >
          清除筛选
        </button>
      )}
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
  marginLeft: 'auto',
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
