import { useState, useEffect, useMemo, useCallback } from 'react';
import { useInstances } from './hooks/useInstances.js';
import { InstanceCard } from './components/InstanceCard.js';
import { InstanceDetail } from './components/InstanceDetail.js';
import { AddInstanceModal } from './components/AddInstanceModal.js';
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
import { LanguageSwitcher } from './components/LanguageSwitcher.js';
import { useI18n } from './i18n/index.js';

/** Top-level shell nav: instances list first (default), then settings sections. */
type AppNav = 'instances' | 'store' | SettingsTab;

const NAV_IDS: AppNav[] = ['instances', 'peer', 'store', 'global'];

function navLabelKey(id: AppNav): 'nav.instances' | 'nav.peer' | 'nav.store' | 'nav.global' | 'nav.engines' {
  if (id === 'instances') return 'nav.instances';
  if (id === 'store') return 'nav.store';
  if (id === 'peer') return 'nav.peer';
  if (id === 'engines') return 'nav.engines';
  return 'nav.global';
}

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

function navTitle(
  nav: AppNav,
  hasSelected: boolean,
  t: ReturnType<typeof useI18n>['t'],
): { title: string; subtitle: string } {
  if (nav === 'instances') {
    return hasSelected
      ? { title: t('title.detail'), subtitle: t('title.detailSub') }
      : { title: t('title.instances'), subtitle: t('title.instancesSub') };
  }
  if (nav === 'store') return { title: t('title.store'), subtitle: t('title.storeSub') };
  if (nav === 'peer') return { title: t('title.peer'), subtitle: t('title.peerSub') };
  if (nav === 'engines') return { title: t('title.engines'), subtitle: t('title.enginesSub') };
  return { title: t('title.global'), subtitle: t('title.globalSub') };
}

export function App() {
  const { t } = useI18n();
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
  const [addAutoPrompted, setAddAutoPrompted] = useState(false);
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

  // Auto-open Add Instance once when the dashboard has zero instances
  // (skip when auth is broken — user must fix the token first).
  useEffect(() => {
    if (addAutoPrompted || loading || showAdd || nav !== 'instances' || selected) {
      return;
    }
    if (isUnauthorizedError(error)) return;
    if (instances.length !== 0) return;
    try {
      if (localStorage.getItem('shepaw_add_dismissed') === '1') {
        setAddAutoPrompted(true);
        return;
      }
    } catch {
      /* private mode */
    }
    setShowAdd(true);
    setAddAutoPrompted(true);
  }, [
    addAutoPrompted,
    loading,
    showAdd,
    nav,
    selected,
    error,
    instances.length,
  ]);

  const dismissAdd = () => {
    setShowAdd(false);
    try {
      localStorage.setItem('shepaw_add_dismissed', '1');
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
        setRestartAllErr(t('instances.restartPartialFail', { details }));
      }
      await reload();
    } catch (e) {
      setRestartAllErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRestartAllBusy(false);
      setShowRestartAllConfirm(false);
    }
  }, [running, reload, t]);

  const heading = navTitle(nav, Boolean(selected), t);
  const summaryKey = instances.length === 1 ? 'instances.summary' : 'instances.summaryPlural';

  return (
    <Layout>
      <div style={topbar}>
        <div>
          <h1 style={title}>{heading.title}</h1>
          <p style={subtitle}>
            {nav === 'instances' && !selected
              ? (loading
                ? t('common.loading')
                : error
                  ? t('common.error', { message: error })
                  : t(summaryKey, { count: instances.length, running }))
              : heading.subtitle}
          </p>
        </div>
        <LanguageSwitcher />
      </div>

      <div style={pageLayout}>
        <nav style={sidebar} aria-label={t('nav.aria')}>
          {NAV_IDS.map((id) => (
            <button
              key={id}
              type="button"
              style={navBtn(nav === id)}
              onClick={() => onNavClick(id)}
            >
              {t(navLabelKey(id))}
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
          onClose={dismissAdd}
          onCreated={(result) => {
            const wasEmpty = instances.length === 0;
            try {
              localStorage.removeItem('shepaw_add_dismissed');
            } catch {
              /* ignore */
            }
            void reload().then(() => {
              if (wasEmpty && result?.started !== false) goSettings('peer');
            });
          }}
          onOpenEngineSettings={openEngineSettings}
        />
      )}

      {showRestartAllConfirm && (
        <ConfirmModal
          title={t('instances.restartAllTitle')}
          message={t('instances.restartAllMessage', { count: running })}
          confirmLabel={t('instances.restartAll')}
          cancelLabel={t('common.cancel')}
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
  onShowAdd: () => void;
  onRestartAll: () => void;
}) {
  const { t } = useI18n();
  return (
    <>
      {restartAllErr && (
        <p style={{ color: '#e74c3c', margin: '0 0 16px', fontSize: 14 }}>{restartAllErr}</p>
      )}

      {isUnauthorizedError(error) && (
        <div style={authBanner}>
          <p style={{ margin: '0 0 12px', color: '#f9e2af', fontSize: 14 }}>
            {t('instances.authNeeded')}
            {t(!getHubAuthToken() ? 'instances.authNoToken' : 'instances.authBadToken')}
            {' '}
            {t('instances.authHint')}
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
          <p style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 600 }}>{t('instances.emptyTitle')}</p>
          <p style={{ color: '#a6adc8', fontSize: 14, margin: '0 0 16px' }}>
            {t('instances.emptyHint')}
          </p>
          <button type="button" style={addBtn} onClick={onShowAdd}>
            {t('instances.add')}
          </button>
        </div>
      )}

      {!loading && instances.length > 0 && filteredInstances.length === 0 && (
        <div style={empty}>
          <p>{t('instances.noneMatch')}</p>
          <button
            style={secondaryBtn}
            type="button"
            onClick={() => onFiltersChange({ search: '', busy: 'all', engine: 'all' })}
          >
            {t('instances.clearFilters')}
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
