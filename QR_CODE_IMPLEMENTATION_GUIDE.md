# QR Code Implementation Guide

## Quick Reference

| Aspect | Details |
|--------|---------|
| **Library** | `qrcode.react` v4.2.0 |
| **Component** | `QRCodeSVG` |
| **Current Use** | Device pairing enrollment codes |
| **Data Source** | Backend generates `qrPayload` |
| **Location** | `/Users/.../agent-hub/ui/src/components/EnrollModal.tsx` |
| **Theme** | Catppuccin dark (hardcoded) |

---

## Current Implementation

### File: `EnrollModal.tsx` (Line 87-93)

```typescript
<QRCodeSVG
  value={token.qrPayload}          // Required: what to encode
  size={200}                        // Pixel size
  bgColor="#1e1e2e"               // Background: dark Catppuccin
  fgColor="#cdd6f4"               // Foreground: light Catppuccin
  level="M"                         // Error correction: Medium
/>
```

### QR Code Display Context

```typescript
interface EnrollModalProps {
  projectId: string;
  onClose: () => void;
  baseUrl?: string;
}

export function EnrollModal({ projectId, onClose, baseUrl: initialBaseUrl }: EnrollModalProps) {
  const [token, setToken] = useState<EnrollToken | null>(null);
  const [loading, setLoading] = useState(false);
  const [tunnelUrl, setTunnelUrl] = useState(initialBaseUrl ?? '');
  const [label, setLabel] = useState('');

  const mint = async () => {
    setLoading(true);
    setErr(null);
    try {
      // 1. Call backend to generate pairing code + QR payload
      const t = await api.enroll.mint(projectId, {
        ttlMinutes: 10,
        label: label || undefined,
        baseUrl: tunnelUrl || undefined,
      });
      setToken(t);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  // 2. Display QR or input form based on token state
  return (
    <div style={overlay}>
      {!token && (
        // Form to generate pairing code
      )}
      {token && (
        // QR code display
        <QRCodeSVG value={token.qrPayload} ... />
      )}
    </div>
  );
}
```

---

## Data Flow: QR Code Generation

```
┌─────────────────────────────┐
│  User clicks "Pair Device"  │
└──────────────┬──────────────┘
               │
               ▼
    ┌──────────────────────┐
    │  EnrollModal opens   │
    │  - Device label      │
    │  - Tunnel URL        │
    └──────────────┬───────┘
                   │
                   ▼
         ┌─────────────────────┐
         │ User generates code │
         │ POST /api/projects/ │
         │    :id/enroll       │
         └──────────┬──────────┘
                    │
                    ▼
       ┌────────────────────────────┐
       │  Backend creates EnrollToken│
       │  {                          │
       │    code: "BASE32ABC...",   │
       │    qrPayload: "{...}",     │
       │    pairUrl: "wss://...",   │
       │    expiresAt: "2024..."    │
       │  }                          │
       └──────────┬─────────────────┘
                  │
                  ▼
     ┌────────────────────────────┐
     │  Frontend receives token   │
     │  - Calls setToken(t)       │
     │  - Re-renders with QR      │
     │  - Passes token.qrPayload  │
     │    to QRCodeSVG            │
     └──────────┬─────────────────┘
                │
                ▼
   ┌──────────────────────────────┐
   │  QRCodeSVG renders           │
   │  <svg>...</svg>              │
   │  - size: 200x200px           │
   │  - colors: Catppuccin        │
   │  - encodes qrPayload JSON    │
   └──────────────────────────────┘
```

---

## QR Payload Structure

The backend generates a JSON payload that gets URL-encoded in the QR:

```typescript
interface QRPayload {
  code: string;           // "ABC123DEF456" - actual pairing code
  url: string;            // "wss://host:port/enroll/ABC123DEF456"
  agentId?: string;       // "my-project" - which agent
  tunnel?: {
    serverUrl: string;
    channelId: string;
  };
}

// Example serialized to QR:
// {"code":"ABC123DEF456","url":"wss://127.0.0.1:8090/enroll/ABC123DEF456","agentId":"my-project"}
```

---

## Usage Patterns

### Basic: Just Show QR

```typescript
<QRCodeSVG
  value={token.qrPayload}
  size={200}
  bgColor="#1e1e2e"
  fgColor="#cdd6f4"
  level="M"
/>
```

### With Fallback Display

```typescript
{token.qrPayload && (
  <div style={qrWrap}>
    <QRCodeSVG
      value={token.qrPayload}
      size={200}
      bgColor="#1e1e2e"
      fgColor="#cdd6f4"
      level="M"
    />
  </div>
)}

<div style={tokenInfo}>
  <p>Or enter code manually:</p>
  <code>{token.display}</code>
</div>
```

### With Download (Enhancement Example)

```typescript
import { useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';

function EnrollModal() {
  const qrRef = useRef<any>(null);

  const downloadQR = () => {
    if (qrRef.current) {
      const canvas = qrRef.current.querySelector('canvas');
      if (canvas) {
        const link = document.createElement('a');
        link.href = canvas.toDataURL('image/png');
        link.download = `pairing-code-${token?.code}.png`;
        link.click();
      }
    }
  };

  return (
    <div ref={qrRef}>
      <QRCodeSVG
        value={token.qrPayload}
        size={200}
        bgColor="#1e1e2e"
        fgColor="#cdd6f4"
        level="M"
      />
      <button onClick={downloadQR}>Download QR</button>
    </div>
  );
}
```

---

## qrcode.react Props Reference

```typescript
interface QRCodeSVGProps {
  // Required
  value: string;              // Data to encode in QR

  // Size
  size?: number;              // Pixel size (default: 128)

  // Colors
  bgColor?: string;           // Background color (hex)
  fgColor?: string;           // Foreground/QR code color (hex)

  // Error correction level
  level?: 'L' | 'M' | 'H' | 'Q';
  // L = 7% recovery
  // M = 15% recovery (default)
  // Q = 25% recovery
  // H = 30% recovery

  // Advanced
  includeMargin?: boolean;    // Include quiet zone (default: false)
  renderAs?: 'svg' | 'canvas'; // Format (default: 'canvas')
  imageSettings?: {
    src: string;
    x?: number;
    y?: number;
    height: number;
    width: number;
    excavate?: boolean;
  };

  // Callbacks
  onRender?: (canvas: HTMLCanvasElement) => void;
}
```

---

## Current Styles in EnrollModal

```typescript
const qrWrap: React.CSSProperties = {
  padding: 16,
  background: '#11111b',    // Very dark background
  borderRadius: 8,
  marginBottom: 16,
};

const tokenInfo: React.CSSProperties = {
  width: '100%',
};

const infoRow: React.CSSProperties = {
  margin: '8px 0',
  display: 'flex',
  gap: 12,
  alignItems: 'flex-start',
  color: '#cdd6f4',
  fontSize: 14,
};

const codeBox: React.CSSProperties = {
  background: '#313244',
  padding: '2px 8px',
  borderRadius: 4,
  fontSize: 14,
  letterSpacing: 2,      // Nice spacing for manual entry code
};
```

---

## Catppuccin Color Theme

The UI uses the **Catppuccin Mocha** color scheme:

```typescript
// Backgrounds
#11111b  // Base (very dark)
#1e1e2e  // Mantle (slightly lighter)
#313244  // Surface (for accents)
#45475a  // Overlay

// Text
#cdd6f4  // Text (light)
#a6adc8  // Subtext (medium)
#6c7086  // Subtext variant (darker)

// Accent colors
#89b4fa  // Blue
#94e2d5  // Teal
#cba6f7  // Mauve
#f38ba8  // Red
#a6e3a1  // Green
#f9e2af  // Yellow
```

QR Code uses:
- **Background**: `#1e1e2e` (Mantle - slightly lighter than base)
- **Foreground**: `#cdd6f4` (Text - high contrast light)

---

## Implementation Patterns in ProjectDetail

### Pattern 1: Inline Editing with Sentinel Values

The ProjectDetail component uses a pattern for secrets that might help:

```typescript
const TUNNEL_SECRET_UNCHANGED = '\x00unchanged';

const openEdit = (p: typeof project) => {
  if (!p) return;
  // Pre-fill sentinel so existing secret is kept when left untouched
  setEditTunnelSecret(p.tunnel ? TUNNEL_SECRET_UNCHANGED : '');
};

<input
  type={editTunnelSecret === TUNNEL_SECRET_UNCHANGED ? 'text' : 'password'}
  value={editTunnelSecret === TUNNEL_SECRET_UNCHANGED
    ? maskSecret(project.tunnel.secret)  // Show masked
    : editTunnelSecret}
  onFocus={() => {
    if (editTunnelSecret === TUNNEL_SECRET_UNCHANGED) setEditTunnelSecret('');
  }}
/>
```

This could be adapted for QR code expiration display!

---

## Security Notes

### What's in the QR?

✅ **Safe to include:**
- Pairing code (single-use, 10-min TTL)
- Enrollment URL (temporary)
- Agent ID (public identifier)
- Channel service URL (if tunnel configured)

❌ **Never include:**
- API keys or credentials
- Private keys
- Tunnel secrets
- Session tokens

### XSS Prevention

`qrcode.react` safely handles encoding - the library:
- URL-encodes the input
- Renders as SVG (no HTML injection risks)
- No eval() or innerHTML used

---

## Testing Notes

### Test Data

```typescript
// Sample EnrollToken
const testToken: EnrollToken = {
  code: "ABC123DEF456GHI789",
  display: "ABC123DEF456",
  label: "Test iPhone",
  expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  pairUrl: "wss://127.0.0.1:8090/enroll/ABC123DEF456",
  qrPayload: JSON.stringify({
    code: "ABC123DEF456GHI789",
    url: "wss://127.0.0.1:8090/enroll/ABC123DEF456",
    agentId: "test-project"
  }),
};
```

### Render Test

```typescript
import { render, screen } from '@testing-library/react';
import { EnrollModal } from './EnrollModal';

test('renders QR code when token present', () => {
  render(<EnrollModal projectId="test" onClose={() => {}} />);
  // Generate token...
  // Assert QR code rendered
});
```

---

## Enhancement Ideas

| Feature | Complexity | Benefit |
|---------|-----------|---------|
| Download QR as PNG | Low | User convenience |
| Copy code to clipboard | Low | Mobile user friendly |
| Print QR | Low | Physical pairing scenarios |
| Animated expiration | Medium | Better UX feedback |
| Larger QR option | Low | Accessibility |
| Custom branding/logo | Medium | Professional appearance |
| Multiple QR codes | Medium | Batch device enrollment |

---

## Dependencies and Imports

```typescript
// In package.json
"dependencies": {
  "qrcode.react": "^4.2.0",
  "react": "^19.1.0",
  "react-dom": "^19.1.0"
}

// In component
import { QRCodeSVG } from 'qrcode.react';
import type { EnrollToken } from '../api/types';
import { useState } from 'react';
```

---

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| QR too small | `size` prop too low | Increase `size` to 250+ |
| Can't scan | Low contrast | Use darker `bgColor`, lighter `fgColor` |
| QR doesn't encode | Data too large | Shorten `qrPayload` or use `level="L"` |
| Blurry appearance | Canvas scaling | Use `renderAs="svg"` explicitly |

