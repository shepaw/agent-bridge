import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Instance } from '../api/types.js';
import { getHubAuthToken } from '../api/client.js';
import { useEngines } from '../hooks/useEngines.js';
import { useI18n } from '../i18n/index.js';
import {
  buildAgentGroups,
  engineState,
  filterAgentGroups,
  type AgentGroup,
} from '../utils/engineGrouping.js';
import { summarizeEngines } from '../utils/engineScan.js';
import { isUnauthorizedError } from '../utils/errors.js';
import { EngineIcon } from './EngineIcon.js';
import { InstanceCard } from './InstanceCard.js';
import { AddCustomEngineForm } from './AddCustomEngineForm.js';
import { HubAuthTokenPanel } from './HubAuthTokenPanel.js';

/**
 * "My Agents" landing page: every engine on this machine in the left rail,
 * instances grouped per engine on the right. Selecting a rail engine smooth-
 * scrolls to its group section; unavailable/disabled engines are greyed with a
 * "Configure" entry. Custom engines are added from the rail footer.
 */
export function AgentsHubPage({
  loading,
  error,
  instances,
  running,
  restartAllBusy,
  restartAllErr,
  onReloadInstances,
  onSelectInstance,
  onAddInstance,
  onRestartAll,
  onGoConfigure,
}: {
  loading: boolean;
  error: string | null;
  instances: Instance[];
  running: number;
  restartAllBusy: boolean;
  restartAllErr: string | null;
  onReloadInstances: () => void;
  onSelectInstance: (id: string) => void;
  onAddInstance: (presetEngineId?: string | null) => void;
  onRestartAll: () => void;
  onGoConfigure: (engineId: string) => void;
}) {
  const { t } = useI18n();
  const { engines, loading: enginesLoading, error: enginesError, reload: reloadEngines } =
    useEngines();
  const [search, setSearch] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showAddCustom, setShowAddCustom] = useState(false);
  const sectionRefs = useRef<Map<string, HTMLElement>>(new Map());

  const groups = useMemo(
    () => (engines ? buildAgentGroups(engines, instances) : []),
    [engines, instances],
  );
  const filteredGroups = useMemo(() => filterAgentGroups(groups, search), [groups, search]);
  const summary = useMemo(() => (engines ? summarizeEngines(engines) : null), [engines]);

  const authNeeded = isUnauthorizedError(error) || isUnauthorizedError(enginesError);
  const retryAll = () => {
    onReloadInstances();
    void reloadEngines();
  };

  // Keep the refs map in sync with the visible sections.
  const attachSectionRef = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    const id = el.getAttribute('data-engine-id');
    if (id) sectionRefs.current.set(id, el);
  }, []);

  useEffect(() => {
    const keep = new Set(filteredGroups.map((g) => g.engine.id));
    for (const key of sectionRefs.current.keys()) {
      if (!keep.has(key)) sectionRefs.current.delete(key);
    }
  }, [filteredGroups]);

  // Track which engine section is under the reading band to highlight the rail.
  useEffect(() => {
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const id = (entry.target as HTMLElement).getAttribute('data-engine-id');
            if (id) setActiveId(id);
          }
        }
      },
      { rootMargin: '-20% 0px -70% 0px' },
    );
    const observed = new Set<HTMLElement>();
    sectionRefs.current.forEach((el) => {
      observed.add(el);
      obs.observe(el);
    });
    return () => {
      observed.forEach((el) => obs.unobserve(el));
      obs.disconnect();
    };
  }, [filteredGroups]);

  const scrollToEngine = useCallback((id: string) => {
    setActiveId(id);
    const el = sectionRefs.current.get(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  return (
    <>
      {restartAllErr && <p style={errText}>{restartAllErr}</p>}

      {authNeeded && (
        <div style={authBanner}>
          <p style={{ margin: '0 0 12px', color: '#f9e2af', fontSize: 14 }}>
            {t('instances.authNeeded')}
            {t(!getHubAuthToken() ? 'instances.authNoToken' : 'instances.authBadToken')}
            {' '}
            {t('instances.authHint')}
          </p>
          <HubAuthTokenPanel onSaved={retryAll} />
        </div>
      )}

      <div style={topBar}>
        <div style={scanArea}>
          <div style={scanSummary}>
            {summary ? (
              <>
                <span style={scanReady}>
                  {t('engine.scanReady', { ready: summary.ready, total: summary.total })}
                </span>
                {summary.needSetup.length > 0 && (
                  <span style={scanNeed}>
                    {t('engine.scanNeedSetup', { count: summary.needSetup.length })}
                  </span>
                )}
                {summary.disabled.length > 0 && (
                  <span style={scanDisabled}>
                    {t('engine.scanDisabled', { count: summary.disabled.length })}
                  </span>
                )}
                {summary.needSetup.map((eng) => (
                  <button
                    key={eng.id}
                    type="button"
                    style={scanChip}
                    title={eng.unavailableReason ?? undefined}
                    onClick={() => scrollToEngine(eng.id)}
                  >
                    {eng.displayName}
                  </button>
                ))}
              </>
            ) : (
              <span style={{ color: '#6c7086', fontSize: 12 }}>
                {enginesLoading ? t('common.loading') : t('common.error', { message: enginesError ?? '' })}
              </span>
            )}
          </div>
          <button
            type="button"
            style={smallBtn}
            disabled={engines === null && enginesLoading}
            onClick={() => void reloadEngines()}
          >
            {t('engine.redetect')}
          </button>
        </div>

        <div style={actionArea}>
          <input
            style={searchInput}
            type="search"
            placeholder={t('filters.search')}
            aria-label={t('filters.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {running > 0 && (
            <button
              type="button"
              style={restartBtn}
              disabled={restartAllBusy}
              onClick={onRestartAll}
            >
              {restartAllBusy ? t('instances.restarting') : t('instances.restartAll')}
            </button>
          )}
          <button type="button" style={addBtn} onClick={() => onAddInstance(null)}>
            {t('instances.addPlus')}
          </button>
        </div>
      </div>

      {enginesError && !isUnauthorizedError(enginesError) && engines === null && (
        <div style={inlineError}>
          <span>{t('common.error', { message: enginesError })}</span>
          <button type="button" style={retryBtn} onClick={() => void reloadEngines()}>
            {t('common.retry')}
          </button>
        </div>
      )}
      {error && !isUnauthorizedError(error) && !loading && instances.length === 0 && (
        <p style={{ color: '#f38ba8', fontSize: 13, margin: '0 0 12px' }}>
          {t('common.error', { message: error })}
        </p>
      )}

      {engines === null && enginesLoading && (
        <div style={loadingBlock}>{t('common.loading')}</div>
      )}

      {engines !== null && (
        <div style={bodyLayout}>
          <aside style={rail} aria-label={t('hub.railAria')}>
            <div style={railHeader}>{t('hub.railTitle')}</div>
            <div style={railList}>
              {filteredGroups.map((g) => (
                <RailItem
                  key={g.engine.id}
                  group={g}
                  active={activeId === g.engine.id}
                  onScroll={() => scrollToEngine(g.engine.id)}
                  onConfigure={() => onGoConfigure(g.engine.id)}
                  onAddAgent={() => onAddInstance(g.engine.id)}
                />
              ))}
            </div>
            {filteredGroups.length === 0 && (
              <p style={{ color: '#6c7086', fontSize: 12, margin: '2px 0 8px' }}>
                {search.trim()
                  ? t('hub.noSearchMatch', { q: search.trim() })
                  : t('instances.emptyHint')}
              </p>
            )}
            <div style={railAdd}>
              {showAddCustom ? (
                <AddCustomEngineForm
                  onDone={() => {
                    setShowAddCustom(false);
                    void reloadEngines();
                  }}
                />
              ) : (
                <button type="button" style={addCustomToggle} onClick={() => setShowAddCustom(true)}>
                  {t('hub.addCustomEngine')}
                </button>
              )}
            </div>
          </aside>

          <div style={groupsCol}>
            {filteredGroups.length === 0 ? (
              <p style={emptyNote}>
                {search.trim()
                  ? t('hub.noSearchMatch', { q: search.trim() })
                  : t('instances.emptyHint')}
              </p>
            ) : (
              filteredGroups.map((g) => (
                <section
                  key={g.engine.id}
                  data-engine-id={g.engine.id}
                  ref={attachSectionRef}
                  style={groupSection}
                >
                  <GroupSection
                    group={g}
                    onSelectInstance={onSelectInstance}
                    onReloadInstances={onReloadInstances}
                    onAddInstance={onAddInstance}
                    onGoConfigure={onGoConfigure}
                  />
                </section>
              ))
            )}
          </div>
        </div>
      )}
    </>
  );
}

function RailItem({
  group,
  active,
  onScroll,
  onConfigure,
  onAddAgent,
}: {
  group: AgentGroup;
  active: boolean;
  onScroll: () => void;
  onConfigure: () => void;
  onAddAgent: () => void;
}) {
  const { t } = useI18n();
  const [hover, setHover] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const state = engineState(group.engine);
  const dim = state !== 'ready';
  const canAdd = group.inCatalog && state === 'ready';
  const countLabel =
    group.count === 1
      ? t('hub.agentCountOne', { count: group.count })
      : t('hub.agentCount', { count: group.count });

  // Close the rail menu on outside mousedown or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDocDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const showMore = hover || menuOpen;

  return (
    <div
      ref={wrapRef}
      style={railItemWrap}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button type="button" style={railItem(active, dim, showMore)} onClick={onScroll} title={group.engine.id}>
        <EngineIcon engineId={group.engine.id} size={20} />
        <span style={railLabel}>{group.engine.displayName}</span>
        {state === 'needs-setup' && (
          <span style={railTagBad}>{t('common.unavailable')}</span>
        )}
        {state === 'disabled' && <span style={railTagBad}>{t('common.disabled')}</span>}
        {group.count > 0 && (
          <span style={railCount} title={countLabel}>{group.count}</span>
        )}
      </button>
      {(hover || menuOpen) && (
        <button
          type="button"
          style={moreBtn(menuOpen)}
          aria-label={t('hub.moreActions')}
          title={t('hub.moreActions')}
          onClick={(ev) => {
            ev.stopPropagation();
            setMenuOpen((v) => !v);
          }}
        >
          ⋯
        </button>
      )}
      {menuOpen && (
        <div style={railMenu}>
          <button
            type="button"
            style={menuItem}
            onClick={() => {
              setMenuOpen(false);
              onConfigure();
            }}
          >
            {t('hub.goConfigure')}
          </button>
          {canAdd && (
            <button
              type="button"
              style={menuItem}
              onClick={() => {
                setMenuOpen(false);
                onAddAgent();
              }}
            >
              {t('hub.addAgent')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function GroupSection({
  group,
  onSelectInstance,
  onReloadInstances,
  onAddInstance,
  onGoConfigure,
}: {
  group: AgentGroup;
  onSelectInstance: (id: string) => void;
  onReloadInstances: () => void;
  onAddInstance: (engineId: string) => void;
  onGoConfigure: (engineId: string) => void;
}) {
  const { t } = useI18n();
  const state = engineState(group.engine);
  const countLabel =
    group.count === 1
      ? t('hub.agentCountOne', { count: group.count })
      : t('hub.agentCount', { count: group.count });

  return (
    <>
      <div style={groupHead}>
        <div style={groupTitleRow}>
          <EngineIcon engineId={group.engine.id} size={24} />
          <h3 style={groupTitle}>{group.engine.displayName}</h3>
          <code style={idTag}>{group.engine.id}</code>
          {group.inCatalog && group.engine.available === true && (
            <span style={readyTag}>{t('common.available')}</span>
          )}
          {group.inCatalog && state === 'needs-setup' && (
            <span
              style={unavailTag}
              title={group.engine.unavailableReason ?? undefined}
            >
              {t('common.unavailable')}
            </span>
          )}
          {group.inCatalog && state === 'disabled' && (
            <span style={disabledTag}>{t('common.disabled')}</span>
          )}
          {group.count > 0 && <span style={countPill}>{countLabel}</span>}
        </div>
        <button
          type="button"
          style={configureLink(group.count === 0 && state !== 'ready')}
          onClick={() => onGoConfigure(group.engine.id)}
        >
          {t('hub.goConfigure')}
        </button>
      </div>

      {group.count > 0 ? (
        <div style={grid}>
          {group.instances.map((p) => (
            <InstanceCard
              key={p.id}
              instance={p}
              onSelect={onSelectInstance}
              onReload={onReloadInstances}
            />
          ))}
        </div>
      ) : !group.inCatalog ? null : state === 'ready' ? (
        <div style={emptyBox}>
          <p style={{ color: '#a6adc8', fontSize: 13, margin: 0 }}>
            {t('hub.noInstancesFor', { name: group.engine.displayName })}
          </p>
          <button type="button" style={primaryBtn} onClick={() => onAddInstance(group.engine.id)}>
            {t('hub.addAgent')}
          </button>
        </div>
      ) : state === 'needs-setup' ? (
        <div style={emptyBox}>
          <p style={{ color: '#fab387', fontSize: 13, margin: 0 }}>
            {group.engine.unavailableReason ?? t('add.engineNotReady')}
          </p>
          <button
            type="button"
            style={configureLink(true)}
            onClick={() => onGoConfigure(group.engine.id)}
          >
            {t('hub.goConfigure')}
          </button>
        </div>
      ) : (
        <div style={emptyBox}>
          <p style={{ color: '#6c7086', fontSize: 13, margin: 0 }}>
            {t('hub.disabledHint')}
          </p>
          <button
            type="button"
            style={configureLink(true)}
            onClick={() => onGoConfigure(group.engine.id)}
          >
            {t('hub.goConfigure')}
          </button>
        </div>
      )}
    </>
  );
}

// ── styles ────────────────────────────────────────────────────────

const errText: React.CSSProperties = {
  color: '#e74c3c',
  margin: '0 0 16px',
  fontSize: 14,
};
const authBanner: React.CSSProperties = {
  background: '#1e1e2e',
  border: '1px solid #f9e2af',
  borderRadius: 10,
  padding: '16px 20px',
  marginBottom: 20,
};
const inlineError: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  color: '#f38ba8',
  fontSize: 13,
  marginBottom: 12,
};
const retryBtn: React.CSSProperties = {
  background: 'transparent',
  color: '#cdd6f4',
  border: '1px solid #45475a',
  borderRadius: 6,
  padding: '5px 12px',
  cursor: 'pointer',
  fontSize: 12,
};
const topBar: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap',
  background: '#1e1e2e',
  border: '1px solid #313244',
  borderRadius: 8,
  padding: '8px 12px',
  marginBottom: 18,
};
const scanArea: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
};
const scanSummary: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
  minWidth: 0,
};
const scanReady: React.CSSProperties = {
  color: '#a6e3a1',
  fontSize: 12,
  fontWeight: 600,
  whiteSpace: 'nowrap',
};
const scanNeed: React.CSSProperties = {
  color: '#fab387',
  fontSize: 12,
  fontWeight: 600,
  whiteSpace: 'nowrap',
};
const scanDisabled: React.CSSProperties = {
  color: '#6c7086',
  fontSize: 12,
  whiteSpace: 'nowrap',
};
const scanChip: React.CSSProperties = {
  background: '#1e1e2e',
  color: '#f38ba8',
  border: '1px solid #f38ba866',
  borderRadius: 999,
  padding: '2px 10px',
  cursor: 'pointer',
  fontSize: 12,
};
const smallBtn: React.CSSProperties = {
  background: 'transparent',
  color: '#cdd6f4',
  border: '1px solid #45475a',
  borderRadius: 5,
  padding: '4px 10px',
  cursor: 'pointer',
  fontSize: 12,
  whiteSpace: 'nowrap',
};
const actionArea: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
};
const searchInput: React.CSSProperties = {
  flex: '1 1 160px',
  minWidth: 130,
  padding: '7px 10px',
  background: '#181825',
  border: '1px solid #313244',
  borderRadius: 6,
  color: '#cdd6f4',
  fontSize: 13,
};
const restartBtn: React.CSSProperties = {
  background: 'transparent',
  color: '#f9e2af',
  border: '1px solid #f9e2af',
  borderRadius: 6,
  padding: '7px 12px',
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: 13,
  whiteSpace: 'nowrap',
};
const addBtn: React.CSSProperties = {
  background: '#89b4fa',
  color: '#11111b',
  border: 'none',
  borderRadius: 6,
  padding: '7px 14px',
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: 13,
  whiteSpace: 'nowrap',
};
const loadingBlock: React.CSSProperties = {
  padding: '40px 0',
  color: '#6c7086',
  textAlign: 'center',
  fontSize: 14,
};

const bodyLayout: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 20,
};
const rail: React.CSSProperties = {
  width: 230,
  flexShrink: 0,
  position: 'sticky',
  top: 16,
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
};
const railHeader: React.CSSProperties = {
  color: '#a6adc8',
  fontSize: 12,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  marginBottom: 8,
  padding: '0 6px',
};
const railList: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};
const railItemWrap: React.CSSProperties = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
};
const railItem = (active: boolean, dim: boolean, showMore: boolean): React.CSSProperties => ({
  flex: 1,
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  background: active ? '#313244' : 'transparent',
  color: dim ? '#6c7086' : active ? '#cdd6f4' : '#a6adc8',
  border: 'none',
  borderRadius: 6,
  // Leave room for the hover "⋯" menu so it never covers the count pill.
  padding: showMore ? '7px 32px 7px 8px' : '7px 8px',
  cursor: 'pointer',
  fontSize: 13,
  textAlign: 'left',
});
const railLabel: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const railTagBad: React.CSSProperties = {
  fontSize: 10,
  padding: '1px 5px',
  background: '#452632',
  color: '#f38ba8',
  borderRadius: 999,
  whiteSpace: 'nowrap',
};
const railCount: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  background: '#313244',
  color: '#89b4fa',
  borderRadius: 999,
  padding: '1px 7px',
  whiteSpace: 'nowrap',
};
const moreBtn = (open: boolean): React.CSSProperties => ({
  position: 'absolute',
  right: 4,
  background: open ? '#313244' : '#181825',
  color: '#a6adc8',
  border: '1px solid #45475a',
  borderRadius: 5,
  width: 24,
  height: 24,
  lineHeight: '18px',
  padding: 0,
  cursor: 'pointer',
  fontSize: 15,
});
const railMenu: React.CSSProperties = {
  position: 'absolute',
  right: 2,
  top: 'calc(100% + 4px)',
  zIndex: 20,
  background: '#1e1e2e',
  border: '1px solid #45475a',
  borderRadius: 8,
  boxShadow: '0 6px 20px rgba(0,0,0,0.45)',
  padding: 4,
  minWidth: 150,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};
const menuItem: React.CSSProperties = {
  background: 'transparent',
  color: '#cdd6f4',
  border: 'none',
  borderRadius: 6,
  padding: '7px 10px',
  cursor: 'pointer',
  fontSize: 13,
  textAlign: 'left',
  whiteSpace: 'nowrap',
};
const railAdd: React.CSSProperties = {
  marginTop: 10,
  paddingTop: 10,
  borderTop: '1px solid #313244',
};
const addCustomToggle: React.CSSProperties = {
  background: 'transparent',
  color: '#89b4fa',
  border: '1px dashed #45475a',
  borderRadius: 6,
  padding: '7px 8px',
  cursor: 'pointer',
  fontSize: 12,
  width: '100%',
};

const groupsCol: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 26,
};
const emptyNote: React.CSSProperties = {
  color: '#a6adc8',
  fontSize: 13,
  margin: '20px 0',
};
const groupSection: React.CSSProperties = {
  scrollMarginTop: 16,
};
const groupHead: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap',
  marginBottom: 12,
};
const groupTitleRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
  minWidth: 0,
};
const groupTitle: React.CSSProperties = {
  margin: 0,
  color: '#cdd6f4',
  fontSize: 17,
  fontWeight: 700,
};
const idTag: React.CSSProperties = {
  fontSize: 11,
  padding: '1px 6px',
  background: '#313244',
  borderRadius: 4,
  color: '#a6adc8',
};
const readyTag: React.CSSProperties = {
  fontSize: 11,
  padding: '1px 6px',
  background: '#3a4a2a',
  color: '#a6e3a1',
  borderRadius: 999,
};
const unavailTag: React.CSSProperties = {
  fontSize: 11,
  padding: '1px 6px',
  background: '#452632',
  color: '#f38ba8',
  borderRadius: 999,
};
const disabledTag: React.CSSProperties = {
  fontSize: 11,
  padding: '1px 6px',
  background: '#313244',
  color: '#6c7086',
  borderRadius: 999,
};
const countPill: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  padding: '1px 8px',
  background: '#313244',
  color: '#89b4fa',
  borderRadius: 999,
};
const configureLink = (emphasis: boolean): React.CSSProperties => ({
  background: 'transparent',
  border: 'none',
  color: emphasis ? '#f38ba8' : '#89b4fa',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: emphasis ? 600 : 400,
  whiteSpace: 'nowrap',
  padding: '4px 6px',
  borderRadius: 6,
});
const grid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
  gap: 16,
};
const emptyBox: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  flexWrap: 'wrap',
  background: '#181825',
  border: '1px dashed #313244',
  borderRadius: 8,
  padding: '14px 16px',
};
const primaryBtn: React.CSSProperties = {
  background: '#89b4fa',
  color: '#11111b',
  border: 'none',
  borderRadius: 6,
  padding: '7px 14px',
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: 13,
  whiteSpace: 'nowrap',
};
