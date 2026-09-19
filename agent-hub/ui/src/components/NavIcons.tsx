import type { CSSProperties, ReactNode } from 'react';

interface IconProps {
  size?: number;
}

function Icon({ size = 18, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={svg}
    >
      {children}
    </svg>
  );
}

const svg: CSSProperties = { display: 'block', flexShrink: 0 };

export function IconAgents({ size }: IconProps) {
  return (
    <Icon size={size}>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.8" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.8" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.8" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.8" />
    </Icon>
  );
}

export function IconPeer({ size }: IconProps) {
  return (
    <Icon size={size}>
      <rect x="7" y="2.5" width="10" height="19" rx="2.2" />
      <path d="M11 18.5h2" />
    </Icon>
  );
}

export function IconStore({ size }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M6 8h12l-1 12.5a2 2 0 0 1-2 1.8H9a2 2 0 0 1-2-1.8L6 8Z" />
      <path d="M9 8V6.5a3 3 0 0 1 6 0V8" />
    </Icon>
  );
}

export function IconSettings({ size }: IconProps) {
  return (
    <Icon size={size}>
      <circle cx="12" cy="12" r="3.1" />
      <path d="M12 3.2v2.2M12 18.6v2.2M4.7 7.1l1.7 1.1M17.6 15.8l1.7 1.1M3.2 12h2.2M18.6 12h2.2M4.7 16.9l1.7-1.1M17.6 8.2l1.7-1.1" />
    </Icon>
  );
}

export function IconOverview({ size }: IconProps) {
  return (
    <Icon size={size}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" />
      <rect x="13.5" y="3.5" width="7" height="4.5" rx="1.6" />
      <rect x="13.5" y="10.5" width="7" height="10" rx="1.6" />
      <rect x="3.5" y="13" width="7" height="7.5" rx="1.6" />
    </Icon>
  );
}

export function IconSessions({ size }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M5 5.5h14a2 2 0 0 1 2 2V15a2 2 0 0 1-2 2H9l-4 3v-3H5a2 2 0 0 1-2-2V7.5a2 2 0 0 1 2-2Z" />
    </Icon>
  );
}

export function IconLogs({ size }: IconProps) {
  return (
    <Icon size={size}>
      <rect x="3.5" y="4" width="17" height="16" rx="2.2" />
      <path d="M7.5 9.2 10 12l-2.5 2.8M12.2 14.8H16.5" />
    </Icon>
  );
}

export function IconDevices({ size }: IconProps) {
  return (
    <Icon size={size}>
      <rect x="3.5" y="7.5" width="11" height="9" rx="1.6" />
      <path d="M14.5 11.5h3.2a1.8 1.8 0 0 1 1.8 1.8V17a1.5 1.5 0 0 1-1.5 1.5h-6" />
    </Icon>
  );
}

export function IconAttachments({ size }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M15.4 7.4 8.2 14.6a2.6 2.6 0 1 0 3.7 3.7l8-8a4.1 4.1 0 0 0-5.8-5.8l-8.3 8.3" />
    </Icon>
  );
}

export function IconResume({ size }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M7 3.5h7.2L19 8.3V20a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 20V5A1.5 1.5 0 0 1 7 3.5Z" />
      <path d="M14 3.6V8.5h5M8.5 12.2h7M8.5 15.6h5.2" />
    </Icon>
  );
}

export function IconConfig({ size }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M4 8h16M8 4.5v7M4 16h16M16 12.5v7" />
    </Icon>
  );
}

export function IconChevronLeft({ size }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M14.5 5.5 8 12l6.5 6.5" />
    </Icon>
  );
}
