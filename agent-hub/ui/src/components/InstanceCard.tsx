import type { Instance } from '../api/types.js';
import { api } from '../api/client.js';
import { availabilityColor, busyColor, busyLabel, formatRuntimeSummary } from '../utils/runtimeStatus.js';
import { useState } from 'react';

interface InstanceCardProps {
  instance: Instance;
  onSelect: (id: string) => void;
  onReload: () => void;
}

export function InstanceCard({ instance: p, onSelect, onReload }: InstanceCardProps) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggle = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (p.status.running) {
        await api.instances.stop(p.id);
      } else {
        await api.instances.start(p.id);
      }
      onReload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={card}>
      <div style={cardHeader}>
        <span style={dot(p.status)} />
        <strong style={{ flex: 1, cursor: 'pointer' }} onClick={() => onSelect(p.id)}>
          {p.label}
        </strong>
        {p.status.busyLevel !== null && p.status.availability === 'online' && (
          <code style={{ ...badge, background: busyColor(p.status), color: '#1e1e2e' }}>
            {busyLabel(p.status)}
          </code>
        )}
        <code style={badge}>{p.engine}</code>
      </div>

      <div style={meta}>
        <span>{formatRuntimeSummary(p.status)}</span>
        <span>ID: <code>{p.id}</code></span>
        <span>Bind: <code>{p.host}:{p.port}</code></span>
      </div>

      <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
        <button
          style={btn(p.status.running ? '#c0392b' : '#27ae60')}
          disabled={busy}
          onClick={() => void toggle()}
        >
          {busy ? '...' : p.status.running ? 'Stop' : 'Start'}
        </button>
        <button style={btn('#2980b9')} onClick={() => onSelect(p.id)}>
          Details
        </button>
      </div>

      {err && <p style={{ color: '#e74c3c', marginTop: 6, fontSize: 13 }}>{err}</p>}
    </div>
  );
}

// ── inline styles ─────────────────────────────────────────────────

const card: React.CSSProperties = {
  background: '#1e1e2e',
  border: '1px solid #313244',
  borderRadius: 8,
  padding: '14px 16px',
};

const cardHeader: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  marginBottom: 8,
};

const meta: React.CSSProperties = {
  fontSize: 13,
  color: '#a6adc8',
  display: 'flex',
  flexWrap: 'wrap',
  gap: '6px 16px',
};

const badge: React.CSSProperties = {
  fontSize: 11,
  padding: '2px 6px',
  background: '#313244',
  borderRadius: 4,
  color: '#cdd6f4',
};

function dot(status: Instance['status']): React.CSSProperties {
  return {
    width: 10,
    height: 10,
    borderRadius: '50%',
    background: availabilityColor(status),
    flexShrink: 0,
  };
}

function btn(bg: string): React.CSSProperties {
  return {
    background: bg,
    color: '#fff',
    border: 'none',
    borderRadius: 5,
    padding: '5px 14px',
    cursor: 'pointer',
    fontSize: 13,
  };
}
