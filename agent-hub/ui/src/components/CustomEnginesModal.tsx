import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import type { EngineInfo } from '../api/types.js';

interface CustomEnginesModalProps {
  onClose: () => void;
}

export function CustomEnginesModal({ onClose }: CustomEnginesModalProps) {
  const [engines, setEngines] = useState<EngineInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [id, setId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [acpCommand, setAcpCommand] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const { engines: list } = await api.engines.list();
      setEngines(list);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      await api.engines.create({
        id: id.trim(),
        displayName: displayName.trim() || id.trim(),
        acpCommand: acpCommand.trim(),
      });
      setId('');
      setDisplayName('');
      setAcpCommand('');
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (engineId: string) => {
    setDeleting(engineId);
    setErr(null);
    try {
      await api.engines.remove(engineId);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(null);
    }
  };

  const custom = engines.filter((e) => !e.builtin);

  return (
    <div style={overlay} onClick={onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <h3 style={{ margin: 0, color: '#cdd6f4' }}>Custom ACP Engines</h3>
          <button style={closeBtn} onClick={onClose}>✕</button>
        </div>

        <div style={body}>
          <p style={{ color: '#a6adc8', fontSize: 13, margin: '0 0 12px' }}>
            Register locally installed ACP CLIs that are not in the built-in list.
            Each entry needs an engine id, display name, and the command used to spawn the upstream agent.
          </p>

          <form onSubmit={(e) => void submit(e)} style={form}>
            <label style={lbl}>Engine ID <span style={req}>*</span></label>
            <input style={inp} value={id} onChange={(e) => setId(e.target.value)} placeholder="my-local-agent" required />

            <label style={lbl}>Display Name</label>
            <input style={inp} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="My Local Agent" />

            <label style={lbl}>ACP Command <span style={req}>*</span></label>
            <input
              style={inp}
              value={acpCommand}
              onChange={(e) => setAcpCommand(e.target.value)}
              placeholder='npx -y my-agent-acp@latest'
              required
            />

            <button type="submit" style={submitBtn} disabled={saving}>
              {saving ? 'Adding...' : 'Add Engine'}
            </button>
          </form>

          {err && <p style={{ color: '#f38ba8', margin: '12px 0 0' }}>{err}</p>}

          <h4 style={sectionTitle}>Registered Custom Engines</h4>
          {loading && <p style={{ color: '#a6adc8', fontSize: 13 }}>Loading...</p>}
          {!loading && custom.length === 0 && (
            <p style={{ color: '#a6adc8', fontSize: 13 }}>No custom engines yet.</p>
          )}
          {custom.map((e) => (
            <div key={e.id} style={row}>
              <div>
                <code style={{ color: '#cdd6f4' }}>{e.id}</code>
                <span style={{ color: '#a6adc8', marginLeft: 8 }}>{e.displayName}</span>
                <div style={{ color: '#6c7086', fontSize: 12, marginTop: 4 }}>{e.acpCommand}</div>
              </div>
              <button
                style={removeBtn}
                disabled={deleting === e.id}
                onClick={() => void remove(e.id)}
              >
                {deleting === e.id ? '…' : 'Remove'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
};

const modal: React.CSSProperties = {
  background: '#1e1e2e', border: '1px solid #45475a', borderRadius: 10,
  width: '90%', maxWidth: 640, maxHeight: '85vh', overflow: 'auto',
};

const header: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  padding: '14px 20px', borderBottom: '1px solid #313244',
};

const body: React.CSSProperties = { padding: 20 };

const closeBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', color: '#a6adc8', fontSize: 18, cursor: 'pointer',
};

const form: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 };

const lbl: React.CSSProperties = { color: '#a6adc8', fontSize: 13 };
const req: React.CSSProperties = { color: '#f38ba8' };

const inp: React.CSSProperties = {
  background: '#11111b', border: '1px solid #45475a', borderRadius: 5,
  color: '#cdd6f4', padding: '8px 12px', fontSize: 13, outline: 'none', fontFamily: 'inherit',
};

const submitBtn: React.CSSProperties = {
  background: '#89b4fa', color: '#11111b', border: 'none',
  borderRadius: 6, padding: '7px 18px', cursor: 'pointer', fontWeight: 600, marginTop: 4,
};

const sectionTitle: React.CSSProperties = {
  color: '#cdd6f4', fontSize: 14, margin: '16px 0 8px', borderTop: '1px solid #313244', paddingTop: 16,
};

const row: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
  gap: 12, padding: '10px 0', borderTop: '1px solid #313244',
};

const removeBtn: React.CSSProperties = {
  background: 'transparent', border: '1px solid #45475a', color: '#f38ba8',
  borderRadius: 4, padding: '4px 8px', fontSize: 11, cursor: 'pointer', flexShrink: 0,
};
