# Agent-Bridge/Agent-Hub Codebase Exploration Report

## Executive Summary

The **Shepaw Agent Hub** is a monorepo project providing unified supervision of multiple Shepaw ACP agent projects. It consists of a **CLI tool** (`shepaw-hub`), a **REST API** (Express.js), a **React dashboard** (Vite), and a **core business logic library**.

---

## 1. Project Structure

### Overall Directory Layout

```
agent-bridge/
├── agent-hub/                    # Main monorepo workspace
│   ├── core/                     # @shepaw/agent-hub-core (business logic)
│   ├── api/                      # @shepaw/agent-hub-api (Express REST API)
│   ├── ui/                       # @shepaw/agent-hub-ui (React dashboard)
│   └── cli/                      # @shepaw/agent-hub-cli (CLI binary: shepaw-hub)
├── implementations/              # Agent implementations
├── sdks/                         # Shepaw ACP SDKs
└── package.json                  # Monorepo root (npm workspaces)
```

### UI Directory Structure (Key Focus)

```
agent-hub/ui/
├── package.json                  # Dependencies: React 19, qrcode.react, Vite
├── vite.config.ts               # Development server + build config
├── tsconfig.json                # TypeScript configuration
└── src/
    ├── App.tsx                  # Main app routing (hash-based navigation)
    ├── main.tsx                 # Vite entry point
    ├── api/
    │   ├── client.ts           # REST API client (fetch wrapper)
    │   └── types.ts            # TypeScript interfaces for API responses
    ├── components/
    │   ├── ProjectDetail.tsx    # Agent detail page (main feature)
    │   ├── ProjectCard.tsx      # Project grid card
    │   ├── EnrollModal.tsx      # QR code generation modal ⭐
    │   ├── AddProjectModal.tsx  # Create new project form
    │   ├── LogViewer.tsx        # WebSocket log streaming component
    │   └── SessionResumeModal.tsx # Session recovery dialog
    ├── hooks/
    │   └── useProjects.ts       # Data fetching hook
    └── utils/
        └── maskSecret.ts        # Secret masking utility
```

---

## 2. Agent Detail Pages Implementation

### Route Structure
- **Hash-based navigation**: `#project/<projectId>`
- No traditional router library (custom implementation)
- URL state synchronization with browser history
- Back/forward navigation support via `hashchange` event

### Main Detail Component: `ProjectDetail.tsx`

**Key Responsibilities:**
- Display comprehensive project information
- Manage project lifecycle (start/stop)
- Handle credential management (env vars)
- Peer authorization management
- Log viewing
- Device pairing (enrollment)
- Session resumption
- Tunnel configuration

**Data Displayed:**
- Project metadata (ID, label, engine type)
- Status (running, PID, start/stop timestamps)
- Binding info (host, port)
- Working directory (CWD)
- Base URL for tunnel access
- Environment variable keys (encrypted values never exposed)
- Tunnel configuration (Channel Service details)
- Authorized peers (devices)
- Live logs (WebSocket streamed)

**UI Sections:**
1. **Header** - Status indicator, quick actions (Start/Stop/Pair/Edit/Remove)
2. **Edit Form** - Update project config (label, CWD, host, baseUrl, tunnel)
3. **Info Grid** - Read-only project details
4. **Credentials Section** - Engine-specific env var management
5. **Tunnel Info** - Channel Service configuration display
6. **Logs** - Live log viewer with tail N lines
7. **Authorized Devices** - Peer management, add/revoke devices

---

## 3. Agent Connection Information Storage

### Data Availability from API

**Project Attributes (Encrypted at Rest):**
```typescript
interface Project {
  id: string;                    // Project ID (e.g., "my-project")
  label: string;                 // Display name
  engine: AgentEngine;           // Type: 'codebuddy'|'claude-code'|'codex'|'opencode'
  cwd: string;                   // Working directory path
  port: number;                  // Local TCP port
  host: string;                  // Bind interface (127.0.0.1 or 0.0.0.0)
  baseUrl: string;               // External URL (tunnel endpoint)
  extraArgs: string[];           // Additional CLI arguments
  createdAt: string;             // ISO 8601 timestamp
  
  tunnel?: {                     // Optional Shepaw Channel Service config
    serverUrl: string;           // Channel service URL
    channelId: string;           // Assigned channel ID
    secret: string;              // HMAC-SHA256 signing secret
  };
  
  envVarKeys: string[];          // Only KEY names exposed (no values!)
  status: {
    running: boolean;
    pid: number | null;
    startedAt: string | null;
    stoppedAt: string | null;
    lastResult: 'graceful'|'hard'|'crashed'|null;
  };
}
```

### Credentials & Secrets

**Environment Variables:**
- Stored **encrypted** in `~/.config/shepaw-hub/projects/<id>/` (AES-256-GCM)
- Only **key names** returned by API (e.g., `ANTHROPIC_API_KEY`, `CODEBUDDY_AUTH_TOKEN`)
- Values **never transmitted over REST API** or exposed in UI plaintext
- Decrypted only at gateway process spawn time
- Engine-specific defaults known:
  - **codebuddy**: `CODEBUDDY_API_KEY`, `CODEBUDDY_AUTH_TOKEN`
  - **claude-code**: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`
  - **codex**: `OPENAI_API_KEY`, `OPENAI_BASE_URL`
  - **opencode**: (none)

**Tunnel Secret:**
- Stored encrypted within tunnel config
- Masked for display: shows first/last few chars + `***`
- Updated via `/api/projects/:id` PATCH with `tunnel.secret`

**Credential Hints Cache:**
- Hub-level cache at `~/.config/shepaw-hub/hub.json`
- Stores masked values only (not plaintext)
- Pre-fills forms for new projects with same engine

---

## 4. QR Code Implementation

### Current QR Library
**Dependency**: `qrcode.react` v4.2.0 (React component wrapper)

### Usage in `EnrollModal.tsx`

```typescript
<QRCodeSVG
  value={token.qrPayload}          // QR data from backend
  size={200}                        // Pixel size
  bgColor="#1e1e2e"               // Dark background (Catppuccin theme)
  fgColor="#cdd6f4"               // Light foreground (Catppuccin theme)
  level="M"                         // Error correction level
/>
```

### QR Code Flow

1. **User clicks "Pair Device"** → Opens `EnrollModal`
2. **User generates pairing code**:
   - Calls `api.enroll.mint(projectId, { ttlMinutes: 10, label?, baseUrl? })`
   - Receives `EnrollToken` with:
     - `code`: Base32 or alphanumeric code
     - `display`: Formatted display string
     - `qrPayload`: JSON payload for QR encoding
     - `expiresAt`: ISO 8601 timestamp
     - `pairUrl`: Full enrollment URL
     - `agentId`, `fingerprint`: Metadata
3. **QR rendered** from `token.qrPayload` (backend generates payload)
4. **Mobile app scans** and extracts enrollment data
5. **Code expires** after 10 minutes or first successful handshake

### EnrollToken Structure
```typescript
interface EnrollToken {
  code: string;           // e.g., "BASE32CODE123"
  display: string;        // Formatted for display
  label: string;          // Device label
  expiresAt: string;      // ISO timestamp
  pairUrl?: string;       // ws://host:port/...
  qrPayload?: string;     // JSON to encode in QR
  agentId?: string;
  fingerprint?: string;
}
```

---

## 5. Frontend Tech Stack

### Core Framework
- **React** 19.1.0 (with React DOM)
- **Vite** 5.4.0 (bundler, dev server)
- **TypeScript** 5.7.2 (type safety)

### Key Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| qrcode.react | 4.2.0 | QR code generation (SVG) |
| react | 19.1.0 | UI framework |
| react-dom | 19.1.0 | React DOM rendering |

### Development Stack
- **@vitejs/plugin-react** 4.3.4 - Vite React plugin
- **@types/react** 19.1.2 - Type definitions
- **@types/react-dom** 19.1.2 - DOM type definitions

### Design/Styling
- **No UI component library** (e.g., no Material-UI, Chakra, etc.)
- **Inline CSS-in-JS** using React `CSSProperties`
- **Catppuccin theme** (dark color scheme hardcoded):
  - Background: `#11111b`, `#1e1e2e`
  - Text: `#cdd6f4`, `#a6adc8`
  - Accents: Blues, purples, greens, reds for status/actions

### Build Configuration

**Vite Dev Server** (`npm run dev`):
- Proxies `/api` → `http://127.0.0.1:4000`
- Proxies `/ws` → `ws://127.0.0.1:4000` (WebSocket)
- Supports HMR (Hot Module Replacement)

**Production Build** (`npm run build`):
- TypeScript compilation → JavaScript
- Vite bundling → `dist/` folder
- Static assets served by Express in production

---

## 6. API Integration

### REST Client (`api/client.ts`)

- Simple **fetch wrapper** with JSON serialization
- Base URL: `/api` (relative to app origin)
- Error handling: throws on non-2xx responses

### API Endpoints

**Projects**
- `GET /api/projects` - List all with live status
- `GET /api/projects/:id` - Get one project + state
- `POST /api/projects` - Register new project
- `PATCH /api/projects/:id` - Update project config
- `DELETE /api/projects/:id` - Remove project
- `POST /api/projects/:id/start` - Start gateway
- `POST /api/projects/:id/stop` - Stop gateway

**Environment Variables**
- `GET /api/projects/:id/envvars` - List keys (values masked)
- `PUT /api/projects/:id/envvars/:key` - Set env var
- `DELETE /api/projects/:id/envvars/:key` - Remove env var

**Enrollment (Pairing)**
- `GET /api/projects/:id/enroll` - List pairing codes
- `POST /api/projects/:id/enroll` - Mint new code + QR
- `DELETE /api/projects/:id/enroll/:code` - Revoke code

**Peers (Device Management)**
- `GET /api/projects/:id/peers` - List authorized devices
- `POST /api/projects/:id/peers` - Add device (by pubkey)
- `DELETE /api/projects/:id/peers/:fp` - Revoke device

**WebSocket**
- `ws://host:port/ws/logs/:projectId?tail=N` - Stream logs

---

## 7. Key Files & Their Roles

| File | Purpose |
|------|---------|
| `App.tsx` | Main app router, hash-based navigation |
| `ProjectDetail.tsx` | ⭐ Main detail page (comprehensive agent view) |
| `ProjectCard.tsx` | Grid card with quick actions |
| `EnrollModal.tsx` | ⭐ QR code generation & display |
| `AddProjectModal.tsx` | New project creation form |
| `LogViewer.tsx` | WebSocket log streaming |
| `SessionResumeModal.tsx` | Session recovery dialog |
| `api/client.ts` | REST API client |
| `api/types.ts` | TypeScript type definitions |
| `hooks/useProjects.ts` | Data fetching hook |
| `utils/maskSecret.ts` | Secret display masking |

---

## 8. State Management Pattern

**Approach**: React hooks (no Redux/Zustand/Context)
- Local component state with `useState`
- Data fetching with `useEffect`
- URL state synced via `location.hash`
- Simple fetch client without caching/global state

**Pattern in ProjectDetail.tsx**:
```typescript
const [project, setProject] = useState<Project | null>(null);
const [peers, setPeers] = useState<Peer[]>([]);
const [envMasked, setEnvMasked] = useState<Record<string, string>>({});
// ... form editing state
// ... modal visibility state
```

---

## 9. Important Architectural Notes

### Secret Handling
1. **Never stored in React state as plaintext** (only key names)
2. **Values encrypted at rest** in `~/.config/shepaw-hub/`
3. **Decrypted only at gateway spawn time**, injected as env vars
4. **Masked for display** (e.g., `sk-ant***789`)
5. **Edit flow uses sentinel values** to avoid re-transmitting unchanged secrets

### Tunnel Configuration
- **Optional per-project tunnel** to Shepaw Channel Service
- **Auto-derives baseUrl** from tunnel when not explicitly set
- **Secret handling**: Pre-filled with sentinel, editable if user types
- **Stored encrypted** alongside project config

### Device Pairing
- **Single-use pairing codes** (10-minute TTL)
- **QR code + manual entry** options
- **Fingerprint-based revocation** for authorized peers
- **X25519 key exchange** for encrypted communication

### Peer Management
- **Public key storage** (no private keys on hub)
- **Fingerprint for reference** (derived from pubkey)
- **Label for human identification** (optional)
- **Add/revoke via API** (express routes in `/api/projects/:id/peers`)

---

## 10. Development Commands

```bash
# UI specific
npm run dev -w agent-hub/ui        # Start dev server on port 5173
npm run build -w agent-hub/ui      # Build for production
npm run typecheck -w agent-hub/ui  # Type check only

# From monorepo root
npm run build                       # Build all packages
npm run typecheck                   # Type check all
```

---

## Summary Table

| Aspect | Details |
|--------|---------|
| **Framework** | React 19 + Vite 5 + TypeScript 5 |
| **QR Library** | qrcode.react 4.2.0 |
| **State Management** | React hooks (useState/useEffect) |
| **Styling** | Inline CSS-in-JS (Catppuccin theme) |
| **Component Library** | None (custom components) |
| **API Client** | Simple fetch wrapper |
| **Build Tool** | Vite 5 |
| **Port (dev)** | 5173 (proxies to API at 4000) |
| **Routing** | Hash-based (`#project/:id`) |
| **Auth** | Peer-to-peer X25519 key exchange |
| **Secret Storage** | AES-256-GCM encrypted files |

---

## Recommendations for QR Code Enhancement

Given the current setup:

1. **Library Choice**: `qrcode.react` is lightweight and well-maintained
   - Alternative: `qr-code-styling` (if fancy designs needed)
   - Current choice: Perfectly suitable for enrollment flows

2. **Data in QR**:
   - Backend (`api/routes/projects.ts`) generates `qrPayload`
   - Frontend just displays via `QRCodeSVG` component
   - No need to move logic to frontend

3. **Enhancement Ideas**:
   - Add download/print QR code feature
   - Configurable QR size + error correction level
   - Animated/blinking when about to expire
   - Display countdown timer to expiration

