import { useEffect, useRef } from 'react';
import { useLogs } from '../hooks/useProjects.js';

interface LogViewerProps {
  projectId: string;
}

export function LogViewer({ projectId }: LogViewerProps) {
  const { lines, connected, clear } = useLogs(projectId, { tail: 200 });
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

  return (
    <div style={wrapper}>
      <div style={toolbar}>
        <span style={{ color: connected ? '#a6e3a1' : '#6c7086', fontSize: 12 }}>
          {connected ? '● live' : '○ disconnected'}
        </span>
        <button style={clearBtn} onClick={clear}>Clear</button>
      </div>
      <pre style={pre}>
        {lines.join('\n') || '(no output yet)'}
        <div ref={bottomRef} />
      </pre>
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────────

const wrapper: React.CSSProperties = {
  background: '#11111b',
  border: '1px solid #313244',
  borderRadius: 8,
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  height: 360,
};

const toolbar: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '6px 12px',
  background: '#1e1e2e',
  borderBottom: '1px solid #313244',
};

const pre: React.CSSProperties = {
  flex: 1,
  margin: 0,
  padding: '10px 14px',
  overflowY: 'auto',
  fontSize: 12,
  lineHeight: 1.6,
  color: '#cdd6f4',
  fontFamily: 'monospace',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const clearBtn: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid #45475a',
  color: '#a6adc8',
  borderRadius: 4,
  padding: '2px 10px',
  cursor: 'pointer',
  fontSize: 12,
};
