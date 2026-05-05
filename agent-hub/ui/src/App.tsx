import { useState } from 'react';
import { useProjects } from './hooks/useProjects.js';
import { ProjectCard } from './components/ProjectCard.js';
import { ProjectDetail } from './components/ProjectDetail.js';
import { AddProjectModal } from './components/AddProjectModal.js';

export function App() {
  const { projects, loading, error, reload } = useProjects();
  const [selected, setSelected] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  if (selected) {
    return (
      <Layout>
        <ProjectDetail
          projectId={selected}
          onBack={() => setSelected(null)}
          onReload={reload}
        />
      </Layout>
    );
  }

  const running = projects.filter((p) => p.status.running).length;

  return (
    <Layout>
      {/* ── Topbar ─────────────────────────────────────────────── */}
      <div style={topbar}>
        <div>
          <h1 style={title}>Shepaw Agent Hub</h1>
          <p style={subtitle}>
            {loading
              ? 'Loading...'
              : error
                ? `Error: ${error}`
                : `${projects.length} project${projects.length === 1 ? '' : 's'} · ${running} running`}
          </p>
        </div>
        <button style={addBtn} onClick={() => setShowAdd(true)}>
          + Add Project
        </button>
      </div>

      {/* ── Project grid ───────────────────────────────────────── */}
      {!loading && projects.length === 0 && (
        <div style={empty}>
          <p>No projects registered yet.</p>
          <p style={{ color: '#a6adc8', fontSize: 14 }}>
            Click "Add Project" or run{' '}
            <code style={inlineCode}>shepaw-hub project add &lt;id&gt; --engine codebuddy --cwd /path</code>
          </p>
        </div>
      )}

      <div style={grid}>
        {projects.map((p) => (
          <ProjectCard
            key={p.id}
            project={p}
            onSelect={setSelected}
            onReload={reload}
          />
        ))}
      </div>

      {showAdd && (
        <AddProjectModal
          onClose={() => setShowAdd(false)}
          onCreated={reload}
        />
      )}
    </Layout>
  );
}

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div style={layoutStyle}>
      <div style={container}>{children}</div>
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────────

const layoutStyle: React.CSSProperties = {
  minHeight: '100vh',
  background: '#11111b',
  color: '#cdd6f4',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
};

const container: React.CSSProperties = {
  maxWidth: 1100,
  margin: '0 auto',
  padding: '24px 20px',
};

const topbar: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  marginBottom: 24,
  flexWrap: 'wrap',
  gap: 12,
};

const title: React.CSSProperties = {
  margin: 0,
  fontSize: 24,
  fontWeight: 700,
  color: '#cdd6f4',
};

const subtitle: React.CSSProperties = {
  margin: '4px 0 0',
  color: '#a6adc8',
  fontSize: 14,
};

const addBtn: React.CSSProperties = {
  background: '#89b4fa',
  color: '#11111b',
  border: 'none',
  borderRadius: 6,
  padding: '8px 18px',
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: 14,
};

const empty: React.CSSProperties = {
  textAlign: 'center',
  padding: '60px 0',
  color: '#cdd6f4',
};

const grid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
  gap: 16,
};

const inlineCode: React.CSSProperties = {
  background: '#313244',
  padding: '1px 6px',
  borderRadius: 3,
  fontSize: 13,
};
