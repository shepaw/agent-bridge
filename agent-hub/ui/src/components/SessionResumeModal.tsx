import { useState } from 'react';
import type { ConversationMessage } from '../api/types.js';

interface SessionResumeProps {
  projectId: string;
  onClose: () => void;
}

export function SessionResumeModal({ projectId, onClose }: SessionResumeProps) {
  const [sessionId, setSessionId] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sessionId.trim()) {
      setErr('Session ID is required');
      return;
    }

    setLoading(true);
    setErr(null);
    setSuccess(null);

    try {
      // In a real scenario, this would call the agent.chat API with resume parameters.
      // For now, we provide instructions since hub doesn't expose agent.chat yet.
      
      const resumePayload = {
        session_id: sessionId,
        message: message || 'continue',
        history: [] as ConversationMessage[],
      };

      setSuccess(
        `Resume request prepared. Use the CLI or app to send:\n\n` +
        JSON.stringify(resumePayload, null, 2),
      );
      
      // Clear form
      setSessionId('');
      setMessage('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={overlay}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <h3 style={{ margin: 0, color: '#cdd6f4' }}>Resume Session — {projectId}</h3>
          <button style={closeBtn} onClick={onClose}>✕</button>
        </div>

        <form onSubmit={(e) => void submit(e)} style={form}>
          <p style={{ color: '#a6adc8', fontSize: 13, margin: '0 0 16px' }}>
            Continue a previous conversation by session ID. The agent will restore
            its internal state and process your new message in context.
          </p>

          <label style={lbl}>Session ID <span style={req}>*</span></label>
          <input
            style={inp}
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            placeholder="shepaw-s1"
            required
          />

          <label style={lbl}>Your Message (optional)</label>
          <textarea
            style={{ ...inp, minHeight: 80, resize: 'vertical' }}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="What would you like to continue with?"
          />

          {err && <p style={{ color: '#f38ba8', margin: '8px 0' }}>{err}</p>}
          {success && (
            <pre style={{ background: '#11111b', color: '#a6e3a1', padding: 12, borderRadius: 4, fontSize: 11, overflow: 'auto', maxHeight: 200, margin: '8px 0' }}>
              {success}
            </pre>
          )}

          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <button type="submit" style={submitBtn} disabled={loading}>
              {loading ? 'Preparing...' : 'Prepare Resume'}
            </button>
            <button type="button" style={cancelBtn} onClick={onClose}>
              Close
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0,
  background: 'rgba(0,0,0,0.6)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 100,
};

const modal: React.CSSProperties = {
  background: '#1e1e2e', border: '1px solid #45475a',
  borderRadius: 10, width: '90%', maxWidth: 520,
};

const header: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  padding: '14px 20px', borderBottom: '1px solid #313244',
};

const closeBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', color: '#a6adc8', fontSize: 18, cursor: 'pointer',
};

const form: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 10, padding: 20,
};

const lbl: React.CSSProperties = { color: '#a6adc8', fontSize: 13 };
const req: React.CSSProperties = { color: '#f38ba8' };

const inp: React.CSSProperties = {
  background: '#11111b', border: '1px solid #45475a', borderRadius: 5,
  color: '#cdd6f4', padding: '8px 12px', fontSize: 13, outline: 'none', fontFamily: 'inherit',
};

const submitBtn: React.CSSProperties = {
  background: '#89b4fa', color: '#11111b', border: 'none',
  borderRadius: 6, padding: '7px 18px', cursor: 'pointer', fontWeight: 600,
};

const cancelBtn: React.CSSProperties = {
  background: 'transparent', border: '1px solid #45475a', color: '#a6adc8',
  borderRadius: 6, padding: '7px 18px', cursor: 'pointer',
};
