import { useState, useEffect, useMemo, useCallback } from 'react';
import { useInstances } from './hooks/useInstances.js';
import { InstanceCard } from './components/InstanceCard.js';
import { InstanceDetail } from './components/InstanceDetail.js';
import { AddInstanceModal } from './components/AddInstanceModal.js';
import { OnboardingWizard } from './components/OnboardingWizard.js';
import { ConfirmModal } from './components/ConfirmModal.js';
import { SettingsPage } from './components/SettingsPage.js';
import { InstanceListFilters, type InstanceListFilterState } from './components/InstanceListFilters.js';
import { filterInstances, uniqueEngines } from './utils/instanceFilters.js';
import { buildSettingsHash, parseSettingsHash, type SettingsTab } from './utils/settingsRoute.js';
import { buildStoreHash, parseStoreHash } from './utils/storeRoute.js';
import {
  buildInstanceHash,
  parseInstanceHash,
  type InstanceDetailTab,
} from './utils/instanceRoute.js';
import { api, getHubAuthToken } from './api/client.js';
import { HubAuthTokenPanel } from './components/HubAuthTokenPanel.js';
import { StoreBrowserPanel } from './components/StoreBrowserPanel.js';

/** Top-level shell nav: instances list first (default), then settings sections. */
type AppNav = 'instances' | 'store' | SettingsTab;

const NAV_ITEMS: { id: AppNav; label: string }[] = [
  { id: 'instances', label: '实例列表' },
  { id: 'peer', label: '扫码配对' },
  { id: 'store', label: '储物袋' },
  { id: 'global', label: '全局设置' },
  { id: 'engines', label: '引擎管理' },
];

function getInitialInstanceRoute() {
  return parseInstanceHash(location.hash);
}

function getInitialNav(): AppNav {
  const store = parseStoreHash(location.hash);
  if (store.active) return 'store';
  const settings = parseSettingsHash(location.hash);
  if (settings.active) return settings.tab;
  return 'instances';
}

function navTitle(nav: AppNav, hasSelected: boolean): { title: string; subtitle: string } {
  if (nav === 'instances') {
    return hasSelected
      ? { title: '实例详情', subtitle: '运行状态 · 会话 · 配置' }
      : { title: '实例列表', subtitle: '管理本机 Agent 实例' };
  }
  if (nav === 'store') return { title: '储物袋', subtitle: '本机 · 配对设备 · Agent 空间' };
  if (nav === 'peer') return { title: '扫码配对', subtitle: '启动 Peer · 扫码连接 App' };
  if (nav === 'global') return { title: '全局设置', subtitle: '鉴权 Token · 默认审核策略' };
  return { title: '引擎管理', subtitle: '内置与自定义引擎' };
}

export function App() {
  const { instances, loading, error, reload } = useInstances();
  const initialRoute = getInitialInstanceRoute();
  const initialSettings = parseSettingsHash(location.hash);
  const initialStore = parseStoreHash(location.hash);
  const [nav, setNav] = useState<AppNav>(getInitialNav);
  const [selected, setSelected] = useState<string | null>(initialRoute?.instanceId ?? null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    initialRoute?.sessionId ?? null,
  );
  const [selectedTab, setSelectedTab] = useState<InstanceDetailTab>(
    initialRoute?.tab ?? 'overview',
  );
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(
    initialSettings.active ? initialSettings.tab : 'global',
  );
  const [focusEngineId, setFocusEngineId] = useState<string | null>(initialSettings.focusEngineId);
  const [storeUri, setStoreUri] = useState<string | null>(initialStore.uri);
  const [showAdd, setShowAdd] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [wizardAutoPrompted, setWizardAutoPrompted] = useState(false);
  const [showRestartAllConfirm, setShowRestartAllConfirm] = useState(false);
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

  const goInstances = useCallback(() => {
    setNav('instances');
    setSelected(null);
    setSelectedSessionId(null);
    setSelectedTab('overview');
    setFocusEngineId(null);
    setStoreUri(null);
  }, []);

  const goStore = useCallback((uri?: string | null) => {
    setNav('store');
    setSelected(null);
    setSelectedSessionId(null);
    setSelectedTab('overview');
    setFocusEngineId(null);
    setStoreUri(uri ?? null);
  }, []);

  const goSettings = useCallback((tab: SettingsTab, engineId?: string | null) => {
    setNav(tab);
    setSettingsTab(tab);
    setSelected(null);
    setSelectedSessionId(null);
    setSelectedTab('overview');
    setFocusEngineId(engineId ?? null);
    setStoreUri(null);
  }, []);

  const openEngineSettings = (engineId: string) => {
    setShowAdd(false);
    setShowWizard(false);
    goSettings('engines', engineId);
  };

  const onNavClick = (id: AppNav) => {
    if (id === 'instances') {
      goInstances();
      return;
    }
    if (id === 'store') {
      goStore(null);
      return;
    }
    goSettings(id);
  };

  // Auto-open the first-run wizard once when the dashboard has zero instances
  // (skip when auth is broken — user must fix the token first).
  useEffect(() => {
    if (wizardAutoPrompted || loading || showWizard || showAdd || nav !== 'instances' || selected) {
      return;
    }
    if (isUnauthorizedError(error)) return;
    if (instances.length !== 0) return;
    try {
      if (localStorage.getItem('shepaw_onboarding_dismissed') === '1') {
        setWizardAutoPrompted(true);
        return;
      }
    } catch {
      /* private mode */
    }
    setShowWizard(true);
    setWizardAutoPrompted(true);
  }, [
    wizardAutoPrompted,
    loading,
    showWizard,
    showAdd,
    nav,
    selected,
    error,
    instances.length,
  ]);

  const dismissWizard = () => {
    setShowWizard(false);
    try {
      localStorage.setItem('shepaw_onboarding_dismissed', '1');
    } catch {
      /* ignore */
    }
  };

  // Keep URL hash in sync with the active view
  useEffect(() => {
    if (selected) {
      location.hash = buildInstanceHash(selected, {
        sessionId: selectedSessionId,
        tab: selectedTab,
      });
    } else if (nav === 'store') {
      location.hash = buildStoreHash(storeUri);
    } else if (nav !== 'instances') {
      location.hash = buildSettingsHash(settingsTab, focusEngineId ?? undefined);
    } else {
      history.replaceState(null, '', location.pathname + location.search);
    }
  }, [selected, selectedSessionId, selectedTab, nav, settingsTab, focusEngineId, storeUri]);

  // Handle browser back/forward navigation
  useEffect(() => {
    const onHashChange = () => {
      const route = parseInstanceHash(location.hash);
      if (route) {
        setNav('instances');
        setSelected(route.instanceId);
        setSelectedSessionId(route.sessionId);
        setSelectedTab(route.tab);
        setFocusEngineId(null);
        setStoreUri(null);
        return;
      }
      const storeRoute = parseStoreHash(location.hash);
      if (storeRoute.active) {
        setNav('store');
        setStoreUri(storeRoute.uri);
        setSelected(null);
        setSelectedSessionId(null);
        setSelectedTab('overview');
        setFocusEngineId(null);
        return;
      }
      const settingsRoute = parseSettingsHash(location.hash);
      if (settingsRoute.active) {
        setNav(settingsRoute.tab);
        setSettingsTab(settingsRoute.tab);
        setFocusEngineId(settingsRoute.focusEngineId);
        setSelected(null);
        setSelectedSessionId(null);
        setSelectedTab('overview');
        setStoreUri(null);
        return;
      }
      setNav('instances');
      setSelected(null);
      setSelectedSessionId(null);
      setSelectedTab('overview');
      setFocusEngineId(null);
      setStoreUri(null);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const running = instances.filter((p) => p.status.running).length;

  const restartAll = useCallback(async () => {
    if (running === 0) return;
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
      setShowRestartAllConfirm(false);
    }
  }, [running, reload]);

  const heading = navTitle(nav, Boolean(selected));

  return (
    <Layout>
      <div style={topbar}>
        <div>
          <h1 style={title}>{heading.title}</h1>
          <p style={subtitle}>
            {nav === 'instances' && !selected
              ? (loading
                ? 'Loading...'
                : error
                  ? `Error: ${error}`
                  : `${instances.length} instance${instances.length === 1 ? '' : 's'} · ${running} running`)
              : heading.subtitle}
          </p>
        </div>
      </div>

      <div style={pageLayout}>
        <nav style={sidebar} aria-label="主导航">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              style={navBtn(nav === item.id)}
              onClick={() => onNavClick(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <main style={contentPanel}>
          {nav === 'instances' && selected ? (
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
              onOpenStore={(uri) => goStore(uri)}
            />
          ) : nav === 'instances' ? (
            <InstancesPanel
              loading={loading}
              error={error}
              instances={instances}
              filteredInstances={filteredInstances}
              filters={filters}
              engines={engines}
              running={running}
              restartAllBusy={restartAllBusy}
              restartAllErr={restartAllErr}
              onFiltersChange={setFilters}
              onSelect={setSelected}
              onReload={reload}
              onShowWizard={() => setShowWizard(true)}
              onShowAdd={() => setShowAdd(true)}
              onRestartAll={() => setShowRestartAllConfirm(true)}
            />
          ) : nav === 'store' ? (
            <StoreBrowserPanel
              initialUri={storeUri}
              onUriChange={setStoreUri}
            />
          ) : (
            <SettingsPage
              tab={settingsTab}
              focusEngineId={focusEngineId}
              onFocusEngineHandled={() => setFocusEngineId(null)}
              onAuthTokenSaved={() => void reload()}
            />
          )}
        </main>
      </div>

      {showAdd && (
        <AddInstanceModal
          onClose={() => setShowAdd(false)}
          onCreated={reload}
          onOpenEngineSettings={openEngineSettings}
        />
      )}

      {showWizard && (
        <OnboardingWizard
          onClose={dismissWizard}
          onOpenEngineSettings={openEngineSettings}
          onFinished={(instanceId) => {
            try {
              localStorage.removeItem('shepaw_onboarding_dismissed');
            } catch {
              /* ignore */
            }
            setShowWizard(false);
            setNav('instances');
            void reload().then(() => {
              setSelected(instanceId);
              setSelectedTab('devices');
            });
          }}
        />
      )}

      {showRestartAllConfirm && (
        <ConfirmModal
          title="重启全部实例"
          message={`确定要重启全部 ${running} 个运行中的实例吗？重启期间相关 Agent 将短暂不可用。`}
          confirmLabel="重启全部"
          tone="warning"
          busy={restartAllBusy}
          onConfirm={() => void restartAll()}
          onCancel={() => {
            if (!restartAllBusy) setShowRestartAllConfirm(false);
          }}
        />
      )}
    </Layout>
  );
}

function InstancesPanel({
  loading,
  error,
  instances,
  filteredInstances,
  filters,
  engines,
  running,
  restartAllBusy,
  restartAllErr,
  onFiltersChange,
  onSelect,
  onReload,
  onShowWizard,
  onShowAdd,
  onRestartAll,
}: {
  loading: boolean;
  error: string | null;
  instances: ReturnType<typeof useInstances>['instances'];
  filteredInstances: ReturnType<typeof useInstances>['instances'];
  filters: InstanceListFilterState;
  engines: string[];
  running: number;
  restartAllBusy: boolean;
  restartAllErr: string | null;
  onFiltersChange: (v: InstanceListFilterState) => void;
  onSelect: (id: string) => void;
  onReload: () => void;
  onShowWizard: () => void;
  onShowAdd: () => void;
  onRestartAll: () => void;
}) {
  return (
    <>
      {restartAllErr && (
        <p style={{ color: '#e74c3c', margin: '0 0 16px', fontSize: 14 }}>{restartAllErr}</p>
      )}

      {isUnauthorizedError(error) && (
        <div style={authBanner}>
          <p style={{ margin: '0 0 12px', color: '#f9e2af', fontSize: 14 }}>
            Dashboard API 需要鉴权
            {!getHubAuthToken() ? '（本机尚未配置 Token）' : '（当前 Token 无效）'}。
            请填写与启动命令中 <code style={inlineCode}>SHEPAW_HUB_TOKEN</code> 相同的值。
          </p>
          <HubAuthTokenPanel onSaved={() => void onReload()} />
        </div>
      )}

      {!loading && instances.length > 0 && (
        <InstanceListFilters
          value={filters}
          engines={engines}
          onChange={onFiltersChange}
          shown={filteredInstances.length}
          total={instances.length}
          runningCount={running}
          restartAllBusy={restartAllBusy}
          restartAllDisabled={loading}
          onRestartAll={onRestartAll}
          onAddInstance={onShowAdd}
        />
      )}

      {!loading && instances.length === 0 && (
        <div style={empty}>
          <p style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 600 }}>还没有 Agent 实例</p>
          <p style={{ color: '#a6adc8', fontSize: 14, margin: '0 0 16px' }}>
            用引导向导在几分钟内把本机引擎接到 Shepaw App，或手动添加实例。
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
            <button type="button" style={addBtn} onClick={onShowWizard}>
              开始引导
            </button>
            <button type="button" style={secondaryBtn} onClick={onShowAdd}>
              手动添加
            </button>
          </div>
          <p style={{ color: '#6c7086', fontSize: 12, marginTop: 16 }}>
            CLI：<code style={inlineCode}>shepaw-hub quickstart</code>
          </p>
        </div>
      )}

      {!loading && instances.length > 0 && filteredInstances.length === 0 && (
        <div style={empty}>
          <p>没有符合筛选条件的实例。</p>
          <button
            style={secondaryBtn}
            type="button"
            onClick={() => onFiltersChange({ search: '', busy: 'all', engine: 'all' })}
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
            onSelect={onSelect}
            onReload={onReload}
          />
        ))}
      </div>
    </>
  );
}

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div style={layoutStyle}>
      <div style={container}>{children}</div>
    </div>
  );
}

function isUnauthorizedError(error: string | null): boolean {
  if (!error) return false;
  return /unauthorized|SHEPAW_HUB_TOKEN/i.test(error);
}

// ── styles ────────────────────────────────────────────────────────

const layoutStyle: React.CSSProperties = {
  minHeight: '100vh',
  background: '#11111b',
  color: '#cdd6f4',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
};

const container: React.CSSProperties = {
  maxWidth: 1280,
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

const pageLayout: React.CSSProperties = {
  display: 'flex',
  gap: 0,
  alignItems: 'stretch',
  minHeight: 480,
};

const sidebar: React.CSSProperties = {
  width: 168,
  flexShrink: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '4px 12px 4px 0',
  borderRight: '1px solid #313244',
};

const navBtn = (active: boolean): React.CSSProperties => ({
  background: active ? '#313244' : 'transparent',
  color: active ? '#89b4fa' : '#cdd6f4',
  border: 'none',
  borderRadius: 6,
  padding: '10px 14px',
  cursor: 'pointer',
  fontWeight: active ? 600 : 400,
  fontSize: 14,
  textAlign: 'left',
});

const contentPanel: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: '4px 0 4px 24px',
};

const authBanner: React.CSSProperties = {
  background: '#1e1e2e',
  border: '1px solid #f9e2af',
  borderRadius: 10,
  padding: '16px 20px',
  marginBottom: 20,
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
