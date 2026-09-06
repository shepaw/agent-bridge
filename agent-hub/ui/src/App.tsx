import { useCallback, useEffect, useRef, useState } from 'react';
import { useInstances } from './hooks/useInstances.js';
import { InstanceDetail } from './components/InstanceDetail.js';
import { AddInstanceModal } from './components/AddInstanceModal.js';
import { ConfirmModal } from './components/ConfirmModal.js';
import { SettingsPage } from './components/SettingsPage.js';
import { SetupGuide } from './components/SetupGuide.js';
import { AgentsHubPage } from './components/AgentsHubPage.js';
import { EngineConfigPage } from './components/EngineConfigPage.js';
import { StoreBrowserPanel } from './components/StoreBrowserPanel.js';
import { LanguageSwitcher } from './components/LanguageSwitcher.js';
import { useI18n } from './i18n/index.js';
import {
  buildEngineHash,
  parseEngineHash,
  parseLegacyEngineSettingsHash,
} from './utils/engineRoute.js';
import { buildSettingsHash, parseSettingsHash, type SettingsTab } from './utils/settingsRoute.js';
import { buildStoreHash, parseStoreHash } from './utils/storeRoute.js';
import {
  buildInstanceHash,
  parseInstanceHash,
  type InstanceDetailTab,
} from './utils/instanceRoute.js';
import { readSetupProgress, writeSetupProgress, type SetupStage } from './utils/setupProgress.js';
import { api } from './api/client.js';
import { isUnauthorizedError } from './utils/errors.js';

/** Top-level shell nav: instances (My Agents) default, then settings sections. */
type AppNav = 'instances' | 'store' | SettingsTab;

const NAV_IDS: AppNav[] = ['instances', 'peer', 'store', 'global'];

function navLabelKey(
  id: AppNav,
): 'nav.instances' | 'nav.store' | 'nav.peer' | 'nav.global' {
  if (id === 'instances') return 'nav.instances';
  if (id === 'store') return 'nav.store';
  if (id === 'peer') return 'nav.peer';
  return 'nav.global';
}

function getInitialInstanceRoute() {
  return parseInstanceHash(location.hash);
}

/** First load: `#engine/<id>` and legacy `#settings/engines` land on the hub. */
function getInitialNav(): AppNav {
  if (parseEngineHash(location.hash)) return 'instances';
  if (parseLegacyEngineSettingsHash(location.hash).active) return 'instances';
  const store = parseStoreHash(location.hash);
  if (store.active) return 'store';
  const settings = parseSettingsHash(location.hash);
  if (settings.active) return settings.tab;
  return 'instances';
}

function getInitialConfigEngineId(): string | null {
  return (
    parseEngineHash(location.hash)?.engineId ??
    parseLegacyEngineSettingsHash(location.hash).engineId
  );
}

function navTitle(
  nav: AppNav,
  hasSelected: boolean,
  hasConfigEngine: boolean,
  t: ReturnType<typeof useI18n>['t'],
): { title: string; subtitle: string } {
  if (nav === 'instances') {
    if (hasSelected) return { title: t('title.detail'), subtitle: t('title.detailSub') };
    if (hasConfigEngine) {
      return { title: t('title.engineConfig'), subtitle: t('title.engineConfigSub') };
    }
    return { title: t('title.instances'), subtitle: t('title.instancesSub') };
  }
  if (nav === 'store') return { title: t('title.store'), subtitle: t('title.storeSub') };
  if (nav === 'peer') return { title: t('title.peer'), subtitle: t('title.peerSub') };
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
  const [configEngineId, setConfigEngineId] = useState<string | null>(getInitialConfigEngineId);
  const [storeUri, setStoreUri] = useState<string | null>(initialStore.uri);
  // First-install guide progress. 'new' = no marker in localStorage (in-memory only).
  const [progress, setProgress] = useState<SetupStage | 'new'>(() => readSetupProgress() ?? 'new');
  // Snapshot whether the page loaded on a hash route (deep link) — those win
  // over first-run / reload redirection.
  const hadRouteHash = useRef(Boolean(location.hash));
  const restoreDone = useRef(false);
  const [showAdd, setShowAdd] = useState(false);
  const [addPresetEngine, setAddPresetEngine] = useState<string | null>(null);
  const [addAutoPrompted, setAddAutoPrompted] = useState(false);
  const [showRestartAllConfirm, setShowRestartAllConfirm] = useState(false);
  const [restartAllBusy, setRestartAllBusy] = useState(false);
  const [restartAllErr, setRestartAllErr] = useState<string | null>(null);

  const goInstances = useCallback(() => {
    setNav('instances');
    setSelected(null);
    setSelectedSessionId(null);
    setSelectedTab('overview');
    setConfigEngineId(null);
    setStoreUri(null);
  }, []);

  const goStore = useCallback((uri?: string | null) => {
    setNav('store');
    setSelected(null);
    setSelectedSessionId(null);
    setSelectedTab('overview');
    setConfigEngineId(null);
    setStoreUri(uri ?? null);
  }, []);

  const goSettings = useCallback((tab: SettingsTab) => {
    setNav(tab);
    setSettingsTab(tab);
    setSelected(null);
    setSelectedSessionId(null);
    setSelectedTab('overview');
    setConfigEngineId(null);
    setStoreUri(null);
  }, []);

  const openEngineConfig = (engineId: string) => {
    setShowAdd(false);
    setNav('instances');
    setSelected(null);
    setSelectedSessionId(null);
    setSelectedTab('overview');
    setConfigEngineId(engineId);
    setStoreUri(null);
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

  const persistProgress = useCallback((stage: SetupStage) => {
    setProgress(stage);
    writeSetupProgress(stage);
  }, []);

  // First-run decision: once the instance list is known and no progress marker
  // exists, route new installs to the engines guide. The default landing page
  // *is* the hub, so no navigation is required — the guide card renders above it.
  useEffect(() => {
    if (loading || isUnauthorizedError(error) || progress !== 'new') return;
    if (instances.length === 0) {
      persistProgress('engines');
    } else {
      // Hub already has instances (e.g. created via CLI) — no guiding needed.
      persistProgress('done');
    }
  }, [loading, error, progress, instances.length, persistProgress]);

  // Reload recovery: after a refresh the guide must stay visible, so restore
  // the page that owns the current step (scan-to-pair page). The engines step
  // lives above the hub, which is the default landing page.
  // Runs once per mount — later manual navigation is never overridden.
  useEffect(() => {
    if (restoreDone.current) return;
    if (loading || isUnauthorizedError(error) || progress === 'new') return;
    restoreDone.current = true;
    if (hadRouteHash.current) return;
    if (progress === 'engines') {
      if (instances.length > 0) {
        // An instance appeared while the guide was open (CLI / another tab) —
        // setup is effectively complete.
        persistProgress('done');
      }
      // Zero instances → keep the guide on the hub (already the landing page).
    } else if (progress === 'pair' && instances.length > 0 && nav === 'instances' && !selected && !configEngineId) {
      goSettings('peer');
    }
  }, [
    loading,
    error,
    progress,
    instances.length,
    nav,
    selected,
    configEngineId,
    goSettings,
    persistProgress,
  ]);

  // Auto-open Add Instance once when the dashboard has zero instances
  // (skip when auth is broken — user must fix the token first).
  // Suppressed during the first-install guide: the hub's engine guide owns the flow.
  useEffect(() => {
    if (addAutoPrompted || loading || showAdd || nav !== 'instances' || selected || configEngineId) {
      return;
    }
    if (isUnauthorizedError(error)) return;
    if (progress === 'new' || progress === 'engines') return;
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
    configEngineId,
    error,
    progress,
    instances.length,
  ]);

  const dismissAdd = () => {
    setShowAdd(false);
    setAddPresetEngine(null);
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
    } else if (configEngineId) {
      location.hash = buildEngineHash(configEngineId);
    } else if (nav === 'store') {
      location.hash = buildStoreHash(storeUri);
    } else if (nav === 'peer' || nav === 'global') {
      location.hash = buildSettingsHash(settingsTab);
    } else {
      history.replaceState(null, '', location.pathname + location.search);
    }
  }, [selected, selectedSessionId, selectedTab, configEngineId, nav, settingsTab, storeUri]);

  // Handle browser back/forward navigation
  useEffect(() => {
    const onHashChange = () => {
      const route = parseInstanceHash(location.hash);
      if (route) {
        setNav('instances');
        setSelected(route.instanceId);
        setSelectedSessionId(route.sessionId);
        setSelectedTab(route.tab);
        setConfigEngineId(null);
        setStoreUri(null);
        return;
      }
      const engineRoute = parseEngineHash(location.hash);
      if (engineRoute) {
        setNav('instances');
        setConfigEngineId(engineRoute.engineId);
        setSelected(null);
        setSelectedSessionId(null);
        setSelectedTab('overview');
        setStoreUri(null);
        return;
      }
      const legacyEngine = parseLegacyEngineSettingsHash(location.hash);
      if (legacyEngine.active) {
        setNav('instances');
        setConfigEngineId(legacyEngine.engineId);
        setSelected(null);
        setSelectedSessionId(null);
        setSelectedTab('overview');
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
        setConfigEngineId(null);
        return;
      }
      const settingsRoute = parseSettingsHash(location.hash);
      if (settingsRoute.active) {
        setNav(settingsRoute.tab);
        setSettingsTab(settingsRoute.tab);
        setSelected(null);
        setSelectedSessionId(null);
        setSelectedTab('overview');
        setConfigEngineId(null);
        setStoreUri(null);
        return;
      }
      setNav('instances');
      setSelected(null);
      setSelectedSessionId(null);
      setSelectedTab('overview');
      setConfigEngineId(null);
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

  // Guide card shown above the page that owns the current setup step.
  const guide: 'engines' | 'pair' | null =
    progress === 'engines' && nav === 'instances' && !selected && !configEngineId && instances.length === 0
      ? 'engines'
      : progress === 'pair' && nav === 'peer' && instances.length > 0
        ? 'pair'
        : null;

  const openCreateFromGuide = () => {
    // Clear the dismissed flag so the Add Instance modal re-opens from the CTA.
    try {
      localStorage.removeItem('shepaw_add_dismissed');
    } catch {
      /* ignore */
    }
    setAddPresetEngine(null);
    setShowAdd(true);
  };

  const skipGuide = () => {
    persistProgress('done');
    if (guide === 'engines') {
      // Skipping the guide also opts out of the 0-instance auto-popup.
      try {
        localStorage.setItem('shepaw_add_dismissed', '1');
      } catch {
        /* ignore */
      }
    }
  };

  const openAdd = (preset?: string | null) => {
    setAddPresetEngine(preset ?? null);
    setShowAdd(true);
  };

  const heading = navTitle(nav, Boolean(selected), Boolean(configEngineId), t);
  const summaryKey = instances.length === 1 ? 'instances.summary' : 'instances.summaryPlural';

  return (
    <Layout>
      <div style={topbar}>
        <div>
          <h1 style={title}>{heading.title}</h1>
          <p style={subtitle}>
            {nav === 'instances' && !selected && !configEngineId
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
              onBack={goInstances}
              onReload={reload}
              onOpenStore={(uri) => goStore(uri)}
            />
          ) : nav === 'instances' && configEngineId ? (
            <EngineConfigPage engineId={configEngineId} onBack={goInstances} />
          ) : nav === 'instances' ? (
            <>
              {guide === 'engines' && (
                <SetupGuide
                  step="engines"
                  onOpenCreate={openCreateFromGuide}
                  onSkip={skipGuide}
                />
              )}
              <AgentsHubPage
                loading={loading}
                error={error}
                instances={instances}
                running={running}
                restartAllBusy={restartAllBusy}
                restartAllErr={restartAllErr}
                onReloadInstances={reload}
                onSelectInstance={(id) => {
                  setSelected(id);
                  setSelectedSessionId(null);
                  setSelectedTab('overview');
                }}
                onAddInstance={openAdd}
                onRestartAll={() => setShowRestartAllConfirm(true)}
                onGoConfigure={openEngineConfig}
              />
            </>
          ) : nav === 'store' ? (
            <StoreBrowserPanel
              initialUri={storeUri}
              onUriChange={setStoreUri}
            />
          ) : (
            <>
              {guide === 'pair' && (
                <SetupGuide step="pair" onSkip={skipGuide} />
              )}
              <SettingsPage
                tab={settingsTab}
                onAuthTokenSaved={() => void reload()}
              />
            </>
          )}
        </main>
      </div>

      {showAdd && (
        <AddInstanceModal
          presetEngineId={addPresetEngine}
          onClose={dismissAdd}
          onCreated={(result) => {
            const wasEmpty = instances.length === 0;
            try {
              localStorage.removeItem('shepaw_add_dismissed');
            } catch {
              /* ignore */
            }
            void reload().then(() => {
              if (wasEmpty && result?.started !== false) {
                // First instance created → advance the guide to phone pairing.
                if (progress === 'engines' || progress === 'pair') persistProgress('pair');
                goSettings('peer');
              }
            });
          }}
          onOpenEngineSettings={openEngineConfig}
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
