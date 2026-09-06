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
import { isUnauthorizedError } from '../utils/errors.js';
import { EngineIcon } from './EngineIcon.js';
import { InstanceCard } from './InstanceCard.js';
import { AddCustomEngineModal } from './AddCustomEngineModal.js';
import { HubAuthTokenPanel } from './HubAuthTokenPanel.js';

/**
 * "My Agents" landing page: every engine on this machine in the left rail,
 * instances grouped per engine on the right. Selecting a rail engine smooth-
 * scrolls to its group section; the group's Configure / Add-agent actions show
 * in its header once that engine is selected or its block is hovered.
 * Custom engines are added from the rail footer.
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
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [showAddCustom, setShowAddCustom] = useState(false);
  const sectionRefs = useRef<Map<string, HTMLElement>>(new Map());
  // While a rail click's smooth scroll is animating, the rail highlight is
  // locked to the clicked engine and the scroll-spy below is ignored until the
  // user actually scrolls. Without this the spy can end up on the *next* engine
  // block: short blocks never reach the old 20%–30% reading band, and the
  // active block's header collapsing/expanding shifts the target a few pixels
  // mid-jump so the scroll lands one block too far.
  const jumpLocked = useRef(false);
  const jumpSettled = useRef(false);

  const groups = useMemo(
    () => (engines ? buildAgentGroups(engines, instances) : []),
    [engines, instances],
  );
  const filteredGroups = useMemo(() => filterAgentGroups(groups, search), [groups, search]);

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

  // Rail "spy": highlight the engine whose group block currently sits at the
  // reading position — the block just under the pinned toolbar. A section is
  // considered "current" once its top crosses the anchor line; the highlight
  // hands over to the next block only when *that* block reaches the same line,
  // so a short block parked by a rail click stays highlighted instead of
  // skipping straight to the engine below it.
  const recomputeActive = useCallback(() => {
    if (jumpLocked.current) return;
    const els = [...sectionRefs.current.values()];
    if (els.length === 0) return;
    const rects = els
      .map((el) => ({
        id: el.getAttribute('data-engine-id'),
        top: el.getBoundingClientRect().top,
        bottom: el.getBoundingClientRect().bottom,
      }))
      .sort((a, b) => a.top - b.top);
    // 92 ≈ scroll-margin-top (66) + the inter-section gap (26): by the time the
    // next block's top reaches this line the previous block has fully cleared
    // the pinned toolbar.
    const anchor = 92;
    let lastAbove: string | null = null;
    let firstBelow: string | null = null;
    for (const r of rects) {
      if (!r.id) continue;
      if (r.top <= anchor) lastAbove = r.id;
      else if (firstBelow === null) firstBelow = r.id;
    }
    let next = lastAbove;
    if (next === null) {
      // Nothing has reached the anchor yet (top of page): highlight the first
      // block that is actually visible at/under it.
      const visible = rects.find((r) => r.id && r.bottom > anchor);
      next = visible?.id ?? firstBelow;
    }
    if (next) setActiveId(next);
  }, [setActiveId]);

  const unlockJump = useCallback(() => {
    jumpLocked.current = false;
    jumpSettled.current = false;
    recomputeActive();
  }, [recomputeActive]);

  // Re-run the spy whenever the visible sections change (initial load, search,
  // engine/instance refresh).
  useEffect(() => {
    recomputeActive();
  }, [filteredGroups, recomputeActive]);

  // Scroll/resize spy. A rail click locks the highlight to the clicked engine:
  // scroll events while the jump animates only arm the "settled" flag, and the
  // lock is released on the first user scroll gesture (wheel / touch / scroll
  // key) or on the first scroll event after the animation has come to rest.
  useEffect(() => {
    let settle: number | undefined;
    const scheduleSettle = () => {
      if (settle !== undefined) window.clearTimeout(settle);
      settle = window.setTimeout(() => {
        settle = undefined;
        if (jumpLocked.current) jumpSettled.current = true;
      }, 180);
    };
    const onScroll = () => {
      if (jumpLocked.current) {
        if (jumpSettled.current) unlockJump();
        else scheduleSettle();
        return;
      }
      recomputeActive();
    };
    const unlock = () => {
      if (jumpLocked.current) unlockJump();
    };
    const SCROLL_KEYS = new Set([
      'ArrowUp',
      'ArrowDown',
      'PageUp',
      'PageDown',
      'Home',
      'End',
      ' ',
    ]);
    const onKeyDown = (e: KeyboardEvent) => {
      if (!SCROLL_KEYS.has(e.key)) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }
      unlock();
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', recomputeActive);
    window.addEventListener('wheel', unlock, { passive: true });
    window.addEventListener('touchstart', unlock, { passive: true });
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', recomputeActive);
      window.removeEventListener('wheel', unlock);
      window.removeEventListener('touchstart', unlock);
      window.removeEventListener('keydown', onKeyDown);
      if (settle !== undefined) window.clearTimeout(settle);
    };
  }, [recomputeActive, unlockJump]);

  const scrollToEngine = useCallback((id: string) => {
    setActiveId(id);
    const el = sectionRefs.current.get(id);
    if (!el) return;
    jumpLocked.current = true;
    jumpSettled.current = false;
    // Defer the scroll by one frame: setActiveId above toggles the previous
    // active block's header actions, which shifts this section a few pixels.
    // Scrolling against the pre-render layout would overshoot by that delta and
    // land on the block below instead.
    requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
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
              <button type="button" style={addCustomToggle} onClick={() => setShowAddCustom(true)}>
                {t('hub.addCustomEngine')}
              </button>
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
                  onMouseEnter={() => setHoveredId(g.engine.id)}
                  onMouseLeave={() => setHoveredId((cur) => (cur === g.engine.id ? null : cur))}
                >
                  <GroupSection
                    group={g}
                    active={activeId === g.engine.id}
                    hovered={hoveredId === g.engine.id}
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

      {showAddCustom && (
        <AddCustomEngineModal
          onClose={() => setShowAddCustom(false)}
          onCreated={() => {
            setShowAddCustom(false);
            void reloadEngines();
          }}
        />
      )}
    </>
  );
}

function RailItem({
  group,
  active,
  onScroll,
}: {
  group: AgentGroup;
  active: boolean;
  onScroll: () => void;
}) {
  const { t } = useI18n();
  const state = engineState(group.engine);
  const dim = state !== 'ready';
  const countLabel =
    group.count === 1
      ? t('hub.agentCountOne', { count: group.count })
      : t('hub.agentCount', { count: group.count });

  return (
    <div style={railItemWrap}>
      <button type="button" style={railItem(active, dim)} onClick={onScroll} title={group.engine.id}>
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
    </div>
  );
}

function GroupSection({
  group,
  active,
  hovered,
  onSelectInstance,
  onReloadInstances,
  onAddInstance,
  onGoConfigure,
}: {
  group: AgentGroup;
  active: boolean;
  hovered: boolean;
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

  const showActions = active || hovered;
  const canAdd = group.inCatalog && state === 'ready';

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
        {showActions && (
          <div style={groupActions}>
            <button
              type="button"
              style={configureLink(group.count === 0 && state !== 'ready')}
              onClick={() => onGoConfigure(group.engine.id)}
            >
              {t('hub.goConfigure')}
            </button>
            {canAdd && (
              <button
                type="button"
                style={configureLink(false)}
                onClick={() => onAddInstance(group.engine.id)}
              >
                {t('hub.addAgent')}
              </button>
            )}
          </div>
        )}
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
// Pinned toolbar: search / restart / add stay visible while the list scrolls.
// Group sections need a matching scroll offset so rail jumps never hide a
// section header behind the pinned toolbar.
const topBar: React.CSSProperties = {
  position: 'sticky',
  top: 0,
  zIndex: 30,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap',
  background: '#1e1e2e',
  border: '1px solid #313244',
  borderRadius: 8,
  boxShadow: '0 4px 14px rgba(0, 0, 0, 0.25)',
  padding: '8px 12px',
  marginBottom: 18,
};
const searchInput: React.CSSProperties = {
  flex: '1 1 auto',
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
  top: 58,
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
  display: 'flex',
  alignItems: 'center',
};
const railItem = (active: boolean, dim: boolean): React.CSSProperties => ({
  flex: 1,
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  background: active ? '#313244' : 'transparent',
  color: dim ? '#6c7086' : active ? '#cdd6f4' : '#a6adc8',
  border: 'none',
  borderRadius: 6,
  padding: '7px 8px',
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
  scrollMarginTop: 66,
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
const groupActions: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexShrink: 0,
};
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
