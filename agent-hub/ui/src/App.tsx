import { useState, useEffect, useMemo, useCallback } from 'react';
import { useInstances } from './hooks/useInstances.js';
import { InstanceCard } from './components/InstanceCard.js';
import { InstanceDetail } from './components/InstanceDetail.js';
import { AddInstanceModal } from './components/AddInstanceModal.js';
import { SettingsPage } from './components/SettingsPage.js';
import { InstanceListFilters, type InstanceListFilterState } from './components/InstanceListFilters.js';
import { filterInstances, uniqueEngines } from './utils/instanceFilters.js';
import { buildSettingsHash, parseSettingsHash, type SettingsTab } from './utils/settingsRoute.js';
import {
  buildInstanceHash,
  parseInstanceHash,
  type InstanceDetailTab,
} from './utils/instanceRoute.js';
import { api } from './api/client.js';

function getInitialInstanceRoute() {
  return parseInstanceHash(location.hash);
}

export function App() {
  const { instances, loading, error, reload } = useInstances();
  const initialRoute = getInitialInstanceRoute();
  const initialSettings = parseSettingsHash(location.hash);
  const [selected, setSelected] = useState<string | null>(initialRoute?.instanceId ?? null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    initialRoute?.sessionId ?? null,
  );
  const [selectedTab, setSelectedTab] = useState<InstanceDetailTab>(
    initialRoute?.tab ?? 'overview',
  );
  const [showSettings, setShowSettings] = useState(initialSettings.active);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(initialSettings.tab);
  const [focusEngineId, setFocusEngineId] = useState<string | null>(initialSettings.focusEngineId);
  const [showAdd, setShowAdd] = useState(false);
  const [restartAllBusy, setRestartAllBusy] = useState(false);
  const [restartAllErr, setRestartAllErr] = useState<string | null>(null);
  const [filters, setFilters] = useState<InstanceListFilterState>({
    search: '',
    busy: 'all',
    engine: 'all',
  });

  const engines = useMemo(() => uniqueEngines(instances), [instances]);
  const filteredInstances = useMemo(
    () => filterInstances(instances, filters),
    [instances, filters],
  );

  const openEngineSettings = (engineId: string) => {
    setShowAdd(false);
    setSelected(null);
    setShowSettings(true);
    setSettingsTab('engines');
    setFocusEngineId(engineId);
    location.hash = buildSettingsHash('engines', engineId);
  };

  // Keep URL hash in sync with the active view
  useEffect(() => {
    if (selected) {
      location.hash = buildInstanceHash(selected, {
        sessionId: selectedSessionId,
        tab: selectedTab,
      });
    } else if (showSettings) {
      location.hash = buildSettingsHash(settingsTab, focusEngineId ?? undefined);
    } else {
      history.replaceState(null, '', location.pathname + location.search);
    }
  }, [selected, selectedSessionId, selectedTab, showSettings, settingsTab, focusEngineId]);

  // Handle browser back/forward navigation
  useEffect(() => {
    const onHashChange = () => {
      const route = parseInstanceHash(location.hash);
      setSelected(route?.instanceId ?? null);
      setSelectedSessionId(route?.sessionId ?? null);
      setSelectedTab(route?.tab ?? 'overview');
      const settingsRoute = parseSettingsHash(location.hash);
      setShowSettings(settingsRoute.active);
      setSettingsTab(settingsRoute.tab);
      setFocusEngineId(settingsRoute.focusEngineId);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  if (selected) {
    return (
      <Layout wide>
        <InstanceDetail
          instanceId={selected}
          activeTab={selectedTab}
          onTabChange={setSelectedTab}
          initialSessionId={selectedSessionId}
          onSessionChange={setSelectedSessionId}
          onBack={() => {
            setSelected(null);
            setSelectedSessionId(null);
            setSelectedTab('overview');
          }}
          onReload={reload}
        />
      </Layout>
    );
  }

  if (showSettings) {
    return (
      <Layout>
        <div style={topbar}>
          <div>
            <h1 style={title}>设置</h1>
            <p style={subtitle}>全局设置 · 引擎管理 · Peer 配对</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
          <button style={secondaryBtn} onClick={() => {
            setShowSettings(false);
            setSettingsTab('global');
            setFocusEngineId(null);
          }}>
            ← 返回实例
          </button>
        </div>
      </div>
        <SettingsPage
          tab={settingsTab}
          onTabChange={setSettingsTab}
          focusEngineId={focusEngineId}
          onFocusEngineHandled={() => setFocusEngineId(null)}
        />
      </Layout>
    );
  }

  const running = instances.filter((p) => p.status.running).length;

  const restartAll = useCallback(async () => {
    if (running === 0) return;
    if (!window.confirm(`确定要重启全部 ${running} 个运行中的实例吗？`)) return;
    setRestartAllBusy(true);
    setRestartAllErr(null);
    try {
      const result = await api.instances.restartAll();
      if (result.failed > 0) {
        const details = result.results
          .filter((r) => r.error !== undefined)
          .map((r) => `${r.id}: ${r.error}`)
          .join('; ');
        setRestartAllErr(`部分实例重启失败: ${details}`);
      }
      await reload();
    } catch (e) {
      setRestartAllErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRestartAllBusy(false);
    }
  }, [running, reload]);

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
                : `${instances.length} instance${instances.length === 1 ? '' : 's'} · ${running} running`}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {running > 0 && (
            <button
              style={restartAllBtn}
              disabled={restartAllBusy || loading}
              onClick={() => void restartAll()}
            >
              {restartAllBusy ? '重启中...' : '重启全部'}
            </button>
          )}
          <button style={secondaryBtn} onClick={() => {
            setSettingsTab('global');
            setFocusEngineId(null);
            setShowSettings(true);
          }}>
            设置
          </button>
          <button style={addBtn} onClick={() => setShowAdd(true)}>
            + Add Instance
          </button>
        </div>
      </div>

      {restartAllErr && (
        <p style={{ color: '#e74c3c', margin: '0 0 16px', fontSize: 14 }}>{restartAllErr}</p>
      )}

      {/* ── Filters + instance grid ─────────────────────────────── */}
      {!loading && instances.length > 0 && (
        <InstanceListFilters
          value={filters}
          engines={engines}
          onChange={setFilters}
          shown={filteredInstances.length}
          total={instances.length}
        />
      )}

      {!loading && instances.length === 0 && (
        <div style={empty}>
          <p>No instances registered yet.</p>
          <p style={{ color: '#a6adc8', fontSize: 14 }}>
            Click "Add Instance" or run{' '}
            <code style={inlineCode}>shepaw-hub instance add &lt;id&gt; --engine codebuddy --cwd /path</code>
          </p>
        </div>
      )}

      {!loading && instances.length > 0 && filteredInstances.length === 0 && (
        <div style={empty}>
          <p>没有符合筛选条件的实例。</p>
          <button
            style={secondaryBtn}
            type="button"
            onClick={() => setFilters({ search: '', busy: 'all', engine: 'all' })}
          >
            清除筛选
          </button>
        </div>
      )}

      <div style={grid}>
        {filteredInstances.map((p) => (
          <InstanceCard
            key={p.id}
            instance={p}
            onSelect={setSelected}
            onReload={reload}
          />
        ))}
      </div>

      {showAdd && (
        <AddInstanceModal
          onClose={() => setShowAdd(false)}
          onCreated={reload}
          onOpenEngineSettings={openEngineSettings}
        />
      )}
    </Layout>
  );
}

function Layout({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div style={layoutStyle}>
      <div style={{ ...container, ...(wide ? { maxWidth: 1280 } : {}) }}>{children}</div>
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

const secondaryBtn: React.CSSProperties = {
  background: 'transparent',
  color: '#cdd6f4',
  border: '1px solid #45475a',
  borderRadius: 6,
  padding: '8px 18px',
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: 14,
};

const restartAllBtn: React.CSSProperties = {
  background: 'transparent',
  color: '#f9e2af',
  border: '1px solid #f9e2af',
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
