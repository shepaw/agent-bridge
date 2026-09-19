import { useState, type CSSProperties, type ReactNode } from 'react';
import { useI18n } from '../i18n/index.js';
import { chat } from '../utils/chatTheme.js';
import { LanguageSwitcher } from './LanguageSwitcher.js';
import { IconAgents, IconPeer, IconSettings, IconStore } from './NavIcons.js';

export type AppNavId = 'instances' | 'peer' | 'store' | 'global';

const NAV_ITEMS: { id: AppNavId; labelKey: 'nav.instances' | 'nav.peer' | 'nav.store' | 'nav.global'; icon: ReactNode }[] = [
  { id: 'instances', labelKey: 'nav.instances', icon: <IconAgents /> },
  { id: 'peer', labelKey: 'nav.peer', icon: <IconPeer /> },
  { id: 'store', labelKey: 'nav.store', icon: <IconStore /> },
  { id: 'global', labelKey: 'nav.global', icon: <IconSettings /> },
];

export function AppSidebar({
  active,
  onSelect,
}: {
  active: AppNavId;
  onSelect: (id: AppNavId) => void;
}) {
  const { t } = useI18n();

  return (
    <aside style={rail}>
      <div style={brand}>
        <img src="/mascot.png" alt="" width={32} height={32} style={brandMark} />
        <div>
          <div style={brandName}>{t('nav.brand')}</div>
          <div style={brandSub}>{t('nav.brandSub')}</div>
        </div>
      </div>

      <nav style={navList} aria-label={t('nav.aria')}>
        {NAV_ITEMS.map((item) => (
          <RailButton
            key={item.id}
            active={active === item.id}
            icon={item.icon}
            label={t(item.labelKey)}
            onClick={() => onSelect(item.id)}
          />
        ))}
      </nav>

      <div style={footer}>
        <LanguageSwitcher fullWidth />
      </div>
    </aside>
  );
}

function RailButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <button
      type="button"
      style={railBtn(active, hovered)}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span style={iconWell(active)}>{icon}</span>
      <span style={railLabel}>{label}</span>
    </button>
  );
}

const { colors, radius } = chat;

const rail: CSSProperties = {
  width: 228,
  flexShrink: 0,
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  background: colors.bgSurface,
  borderRight: `1px solid ${colors.borderSubtle}`,
  padding: '18px 12px 14px',
  boxSizing: 'border-box',
};

const brand: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '4px 8px 18px',
};

const brandMark: CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: 10,
  objectFit: 'cover',
  boxShadow: '0 0 0 1px rgba(49, 50, 68, 0.7)',
};

const brandName: CSSProperties = {
  fontSize: 15,
  fontWeight: 700,
  letterSpacing: '-0.02em',
  color: colors.textPrimary,
  lineHeight: 1.2,
};

const brandSub: CSSProperties = {
  marginTop: 2,
  fontSize: 11,
  color: colors.textMuted,
  letterSpacing: '0.02em',
};

const navList: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  flex: 1,
};

const footer: CSSProperties = {
  marginTop: 'auto',
  paddingTop: 14,
  borderTop: `1px solid ${colors.borderSubtle}`,
};

const railBtn = (active: boolean, hovered: boolean): CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  width: '100%',
  background: active
    ? colors.bgSelected
    : hovered
      ? colors.bgHover
      : 'transparent',
  color: active ? colors.accent : colors.textPrimary,
  border: 'none',
  borderRadius: radius.md,
  padding: '7px 8px',
  cursor: 'pointer',
  fontWeight: active ? 600 : 500,
  fontSize: 14,
  textAlign: 'left',
  letterSpacing: '-0.01em',
  boxShadow: active ? `inset 0 0 0 1px rgba(137, 180, 250, 0.18)` : 'none',
  transition: 'background 140ms ease, color 140ms ease, box-shadow 140ms ease',
});

const iconWell = (active: boolean): CSSProperties => ({
  width: 32,
  height: 32,
  borderRadius: 9,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  background: active ? 'rgba(137, 180, 250, 0.18)' : colors.bgElevated,
  color: active ? colors.accent : colors.textSecondary,
});

const railLabel: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
