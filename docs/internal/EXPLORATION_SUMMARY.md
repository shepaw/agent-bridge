# Agent-Bridge/Agent-Hub Codebase Exploration - Summary

## Overview

This exploration provides a comprehensive understanding of the **Shepaw Agent Hub** monorepo, with specific focus on:
1. Project structure and file organization
2. Agent detail page implementation
3. Connection information storage and security
4. QR code implementation for device pairing
5. Frontend technology stack

---

## Generated Documentation

Three detailed documents have been created:

### 1. **CODEBASE_EXPLORATION.md** (Main Reference)
- **Purpose**: Comprehensive overview of the entire codebase
- **Contents**:
  - Project structure and directory layout
  - Agent detail page implementation (routes, components)
  - Connection information storage model
  - QR code library and usage
  - Frontend tech stack details
  - API integration patterns
  - Key files and their roles
  - State management approach
  - Architectural notes

### 2. **AGENT_DATA_MODEL.md** (Data Reference)
- **Purpose**: Deep dive into agent data model and credential storage
- **Contents**:
  - Complete agent data model structure
  - Credential storage architecture (at rest and in transit)
  - API response examples
  - Environment variables by engine type
  - Secret masking function
  - Data flow diagrams
  - UI component dependencies
  - Security considerations matrix

### 3. **QR_CODE_IMPLEMENTATION_GUIDE.md** (Technical Implementation)
- **Purpose**: Quick reference and implementation guide for QR codes
- **Contents**:
  - Current qrcode.react implementation
  - Props reference
  - QR code display context
  - Data flow diagrams
  - Usage patterns (basic, with fallback, with download)
  - Catppuccin color theme reference
  - Implementation patterns from ProjectDetail
  - Security notes
  - Troubleshooting guide
  - Enhancement ideas

---

## Quick Facts

### Project Structure
```
agent-bridge/agent-hub/
├── core/    → Business logic & config
├── api/     → Express REST API
├── ui/      → React dashboard (Vite)
└── cli/     → CLI binary
```

### Frontend Stack
| Component | Technology | Version |
|-----------|-----------|---------|
| Framework | React | 19.1.0 |
| Bundler | Vite | 5.4.0 |
| Language | TypeScript | 5.7.2 |
| **QR Library** | **qrcode.react** | **4.2.0** |
| UI Components | None (custom) | N/A |
| Styling | Inline CSS-in-JS | Catppuccin |

### Agent Data Available
- **Public**: ID, label, engine type, host, port, baseUrl, status
- **Infrastructure**: CWD, extraArgs, timestamps, tunnel config
- **Credentials**: Only KEY NAMES exposed (never values!)
- **Encrypted at Rest**: All env var values (AES-256-GCM)
- **Decrypted At**: Gateway process spawn time only

### QR Code Implementation
- **Component**: `QRCodeSVG` from qrcode.react
- **Location**: `ProjectDetail.tsx` → `EnrollModal.tsx`
- **Data Source**: Backend generates `qrPayload` JSON
- **Use Case**: Device pairing/enrollment (single-use, 10-min TTL)
- **Styling**: Catppuccin theme (hardcoded colors)

---

## Key Findings

### 1. Routing
- ✅ Hash-based navigation (`#project/:id`)
- ✅ Browser back/forward support
- ✅ No third-party router library needed
- ✅ Simple to understand implementation

### 2. Agent Detail Pages
- ✅ Comprehensive `ProjectDetail.tsx` component
- ✅ Covers: lifecycle, credentials, peers, logs, tunneling
- ✅ Inline editing with sentinel values for secrets
- ✅ Real-time status updates
- ✅ WebSocket log streaming

### 3. Credential Security
- ✅ **Never** plaintext in React state
- ✅ **Only key names** exposed via API
- ✅ **Encrypted** in hub config (AES-256-GCM)
- ✅ **Masked** for display (e.g., "sk-ant***789")
- ✅ **File permissions** 0600 (owner-only readable)

### 4. QR Code
- ✅ Current library (`qrcode.react`) is lightweight & maintained
- ✅ Simple SVG rendering with no external dependencies
- ✅ Backend controls payload generation (no frontend logic needed)
- ✅ Theme-aware colors (Catppuccin)
- ✅ Easily customizable (size, error correction level)

### 5. State Management
- ✅ React hooks only (no Redux/Zustand/Context)
- ✅ Local component state with `useState`
- ✅ URL state via `location.hash`
- ✅ Simple fetch-based API client
- ✅ No caching layer (reload on navigate)

---

## Data Flow Summary

### Creating a New Project (Agent)
```
User → Add Form → api.projects.create()
                    ↓
                Backend registers
                (creates hub.json entry)
                    ↓
                Returns Project object
                    ↓
                UI updates grid
```

### Viewing Project Details
```
User clicks "Details" → Hash route changes
                          ↓
                    ProjectDetail loads
                          ↓
                    Parallel fetches:
                    - api.projects.get()
                    - api.peers.list()
                    - api.envvars.list()
                          ↓
                    State populated
                          ↓
                    Render complete UI
```

### Pairing a Device
```
User → "Pair Device" button
            ↓
        EnrollModal opens
            ↓
        User enters label, tunnel URL
            ↓
        User clicks "Generate Code"
            ↓
        api.enroll.mint() → Backend generates:
                    - Single-use code
                    - QR payload JSON
                    - Pairing URL
            ↓
        Frontend receives EnrollToken
            ↓
        QRCodeSVG renders from token.qrPayload
            ↓
        Mobile app scans
            ↓
        Device enrolled + authorized
```

### Updating a Credential
```
User clicks "Update" on ANTHROPIC_API_KEY
        ↓
    Inline editor opens
    (shows masked current value)
        ↓
    User types new value
        ↓
    User clicks "Save"
        ↓
    api.envvars.set(key, value)
        ↓
    Backend:
    - Encrypts value
    - Stores in hub.json
    - Updates credential hints
        ↓
    Frontend reloads project
    (updates envMasked map)
        ↓
    UI displays success
```

---

## Important Architectural Patterns

### Pattern 1: Sentinel Values for Secrets
```typescript
const TUNNEL_SECRET_UNCHANGED = '\x00unchanged';

// Pre-fill with sentinel
setEditTunnelSecret(p.tunnel ? TUNNEL_SECRET_UNCHANGED : '');

// In render: Check if sentinel, then show masked or show password field
value={editTunnelSecret === TUNNEL_SECRET_UNCHANGED
  ? maskSecret(project.tunnel.secret)
  : editTunnelSecret}

// On save: Only send to API if changed (not sentinel)
const effectiveSecret = secretUnchanged ? '' : editTunnelSecret;
```

**Why?** Prevents re-transmission of unchanged secrets while still showing masked value to user.

### Pattern 2: Component Composition
```
App.tsx (router)
├── ProjectCard (grid item)
└── ProjectDetail (detail page)
    ├── EnrollModal (QR code pairing)
    ├── LogViewer (WebSocket logs)
    ├── SessionResumeModal (recovery)
    └── Inline forms (edit project, add peer)
```

### Pattern 3: Async Error Handling
```typescript
const [busy, setBusy] = useState(false);
const [err, setErr] = useState<string | null>(null);

const toggle = async () => {
  setBusy(true);
  setErr(null);  // Clear previous error
  try {
    // API call
    await api.projects.stop(id);
  } catch (e) {
    setErr(e instanceof Error ? e.message : String(e));
  } finally {
    setBusy(false);
  }
};
```

---

## File Locations Quick Reference

| File | Purpose | Lines |
|------|---------|-------|
| `App.tsx` | Main router | 98 |
| `ProjectDetail.tsx` | Agent detail page | **776** |
| `EnrollModal.tsx` | QR code modal | 237 |
| `ProjectCard.tsx` | Grid card | 119 |
| `api/client.ts` | REST client | 89 |
| `api/types.ts` | TypeScript types | 101 |
| `hooks/useProjects.ts` | Data fetching | ? |
| `utils/maskSecret.ts` | Secret masking | ? |

---

## Development Environment Setup

### Development Server
```bash
npm run dev -w agent-hub/ui
# Vite dev server on http://localhost:5173
# Auto-proxies /api and /ws to http://localhost:4000
```

### Build
```bash
npm run build -w agent-hub/ui
# Creates dist/ folder with optimized bundle
```

### Type Check
```bash
npm run typecheck -w agent-hub/ui
# TypeScript validation
```

---

## Security Considerations

| Aspect | Level | Notes |
|--------|-------|-------|
| Credential storage | 🟢 Strong | AES-256-GCM encrypted |
| API exposure | 🟢 Strong | Only key names, never values |
| UI display | 🟡 Good | Masked values shown |
| Tunnel secret | 🟡 Good | Raw value in API (should mask) |
| QR payload | 🟢 Strong | Single-use, 10-min TTL |
| File permissions | 🟢 Strong | 0600 (owner-only) |
| Session data | 🟢 Strong | No persistence in storage |

---

## Recommendations

### For QR Code Enhancement
1. ✅ Library choice is excellent (lightweight, maintained)
2. ✅ Current implementation is solid
3. **Enhancement ideas** (low effort):
   - Add download/print button
   - Display countdown timer to expiration
   - Add copy-to-clipboard for manual code entry
   - Larger QR size option for accessibility

### For Data Model
1. ✅ Security practices are strong
2. ✅ Encryption at rest is comprehensive
3. **Considerations**:
   - Consider masking `tunnel.secret` in API responses
   - Could add audit logging for credential access

### For Developer Experience
1. ✅ TypeScript provides strong type safety
2. ✅ Inline styles are OK for small app, consider CSS/Tailwind if scales
3. **Optional improvements**:
   - Add React Query for data fetching/caching
   - Consider component library (Headless UI, Radix) if complexity grows

---

## Next Steps

Now that you understand the codebase:

1. **For QR Code Features**: Review `QR_CODE_IMPLEMENTATION_GUIDE.md`
2. **For Agent Data**: Review `AGENT_DATA_MODEL.md`
3. **For Full Architecture**: Review `CODEBASE_EXPLORATION.md`

Each document is self-contained and includes:
- Code examples
- Type definitions
- Data flow diagrams
- Security notes
- Implementation patterns

---

## Document Locations

```
/Users/edenzou/workspace/shepaw/agent-bridge/
├── CODEBASE_EXPLORATION.md       ← Main reference
├── AGENT_DATA_MODEL.md           ← Data structures
├── QR_CODE_IMPLEMENTATION_GUIDE.md ← QR implementation
└── EXPLORATION_SUMMARY.md        ← This file
```

All files are markdown (.md) and can be viewed in any text editor or markdown viewer.

