import { useI18n } from '../i18n/index.js';

interface SessionModeOption {
  id: string;
  name: string;
  description: string;
}

export function SessionModeSelect({
  modes,
  value,
  onChange,
  disabled,
}: {
  modes: ReadonlyArray<SessionModeOption>;
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  if (modes.length === 0) {
    return (
      <p style={{ color: '#6c7086', fontSize: 12, margin: 0 }}>
        {t('sessionMode.empty')}
      </p>
    );
  }
  const current = modes.find((m) => m.id === value);
  return (
    <>
      <select
        style={inp}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {modes.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
      {current?.description && (
        <p style={{ color: '#6c7086', fontSize: 12, margin: '4px 0 0' }}>{current.description}</p>
      )}
    </>
  );
}

const inp: React.CSSProperties = {
  background: '#11111b', border: '1px solid #45475a', borderRadius: 5,
  color: '#cdd6f4', padding: '6px 10px', fontSize: 14, outline: 'none', width: '100%',
  boxSizing: 'border-box',
};
