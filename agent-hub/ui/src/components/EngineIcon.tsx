import { useState } from 'react';
import { getEngineIconUrl } from '../utils/engineIcons.js';

interface EngineIconProps {
  engineId: string;
  /** Pixel size of the icon box (default 28). */
  size?: number;
  title?: string;
}

export function EngineIcon({ engineId, size = 28, title }: EngineIconProps) {
  const [failed, setFailed] = useState(false);
  const label = title ?? engineId;
  const url = getEngineIconUrl(engineId);

  if (failed) {
    const initial = (engineId.trim()[0] ?? '?').toUpperCase();
    return (
      <span
        style={{ ...box(size), ...fallback }}
        title={label}
        aria-label={label}
        role="img"
      >
        {initial}
      </span>
    );
  }

  return (
    <span
      style={box(size)}
      title={label}
      aria-label={label}
      role="img"
    >
      <img
        src={url}
        alt=""
        width={size - 8}
        height={size - 8}
        style={{ display: 'block', objectFit: 'contain' }}
        draggable={false}
        onError={() => setFailed(true)}
      />
    </span>
  );
}

function box(size: number): React.CSSProperties {
  return {
    width: size,
    height: size,
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#cdd6f4',
    borderRadius: 6,
    overflow: 'hidden',
  };
}

const fallback: React.CSSProperties = {
  background: '#313244',
  color: '#89b4fa',
  fontSize: 13,
  fontWeight: 700,
  fontFamily: 'system-ui, sans-serif',
};
