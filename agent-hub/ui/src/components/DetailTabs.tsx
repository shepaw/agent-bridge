import { useState, type CSSProperties, type ReactNode } from 'react';
import { useI18n } from '../i18n/index.js';
import type { InstanceDetailTab } from '../utils/instanceRoute.js';
import { chat } from '../utils/chatTheme.js';
import {
  IconAttachments,
  IconConfig,
  IconDevices,
  IconLogs,
  IconOverview,
  IconResume,
  IconSessions,
} from './NavIcons.js';

const TAB_ITEMS: {
  id: InstanceDetailTab;
  labelKey:
    | 'detail.overview'
    | 'detail.sessions'
    | 'detail.logs'
    | 'detail.devices'
    | 'detail.attachments'
    | 'detail.resumeTab'
    | 'detail.config';
  icon: ReactNode;
}[] = [
  { id: 'overview', labelKey: 'detail.overview', icon: <IconOverview size={16} /> },
  { id: 'sessions', labelKey: 'detail.sessions', icon: <IconSessions size={16} /> },
  { id: 'logs', labelKey: 'detail.logs', icon: <IconLogs size={16} /> },
  { id: 'devices', labelKey: 'detail.devices', icon: <IconDevices size={16} /> },
  { id: 'attachments', labelKey: 'detail.attachments', icon: <IconAttachments size={16} /> },
  { id: 'resume', labelKey: 'detail.resumeTab', icon: <IconResume size={16} /> },
  { id: 'config', labelKey: 'detail.config', icon: <IconConfig size={16} /> },
];

export function DetailTabs({
  active,
  onChange,
}: {
  active: InstanceDetailTab;
  onChange: (tab: InstanceDetailTab) => void;
}) {
  const { t } = useI18n();

  return (
    <nav style={wrap} aria-label={t('nav.ariaDetail')}>
      <div style={track} role="tablist">
        {TAB_ITEMS.map((item) => (
          <TabButton
            key={item.id}
            active={active === item.id}
            icon={item.icon}
            label={t(item.labelKey)}
            onClick={() => onChange(item.id)}
          />
        ))}
      </div>
    </nav>
  );
}

function TabButton({
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
      role="tab"
      aria-selected={active}
      style={tabBtn(active, hovered)}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span style={tabIcon(active)}>{icon}</span>
      {label}
    </button>
  );
}

const { colors, radius, shadow } = chat;

const wrap: CSSProperties = {
  marginBottom: 18,
};

const track: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 4,
  padding: 4,
  background: colors.bgSurface,
  border: `1px solid ${colors.borderSubtle}`,
  borderRadius: radius.lg,
};

const tabBtn = (active: boolean, hovered: boolean): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  background: active ? colors.bgElevated : hovered ? colors.bgHover : 'transparent',
  color: active ? colors.textPrimary : colors.textSecondary,
  border: 'none',
  borderRadius: radius.md,
  padding: '8px 12px',
  cursor: 'pointer',
  fontWeight: active ? 600 : 500,
  fontSize: 13,
  letterSpacing: '-0.01em',
  boxShadow: active ? shadow.sm : 'none',
  transition: 'background 140ms ease, color 140ms ease, box-shadow 140ms ease',
});

const tabIcon = (active: boolean): CSSProperties => ({
  display: 'inline-flex',
  color: active ? colors.accent : colors.textMuted,
});
