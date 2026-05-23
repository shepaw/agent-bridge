# Shepaw Agent Hub - Architecture Diagrams

## System Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                    CLIENT BROWSER                               │
├──────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  React 19 SPA (@shepaw/agent-hub-ui)                       │ │
│  │  ├─ App.tsx (hash router)                                 │ │
│  │  ├─ ProjectDetail.tsx (agent management)                  │ │
│  │  ├─ EnrollModal.tsx (QR code pairing)                     │ │
│  │  └─ Other components (ProjectCard, LogViewer, etc)        │ │
│  │                                                             │ │
│  │  Styling: Catppuccin theme, inline CSS-in-JS              │ │
│  │  Build: Vite 5, TypeScript 5.7                            │ │
│  │  Dev port: 5173 (proxies to API at 4000)                  │ │
│  └────────────────────────────────────────────────────────────┘ │
│         │                                        │              │
│         └────────────┬─────────────────────────┬┘              │
│                      │ REST + WS               │               │
│                      ▼                         ▼               │
└──────────────────────┼─────────────────────────┼──────────────┘
                       │                         │
                 ┌─────┴─────────────────────────┴─────┐
                 │   HTTP + WebSocket (port 4000)      │
                 │   Secure boundary                   │
                 └─────┬─────────────────────────┬─────┘
                       │                         │
                       ▼                         ▼
┌──────────────────────────────────────────────────────────────────┐
│                    SERVER (Hub Host)                            │
├──────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Express REST API (@shepaw/agent-hub-api)                 │ │
│  │  ├─ /api/projects/*        → Project CRUD                │ │
│  │  ├─ /api/projects/:id/peers → Device management          │ │
│  │  ├─ /api/projects/:id/enroll → Pairing codes + QR        │ │
│  │  ├─ /api/projects/:id/envvars → Credentials (masked)     │ │
│  │  └─ /ws/logs/:id            → WebSocket log streaming    │ │
│  └────────────────────────────────────────────────────────────┘ │
│                         │                                       │
│                         ▼                                       │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Core Library (@shepaw/agent-hub-core)                    │ │
│  │  ├─ config.ts        → Hub config, project registry      │ │
│  │  ├─ crypto.ts        → AES-256-GCM encryption            │ │
│  │  ├─ spawn.ts         → Gateway process lifecycle          │ │
│  │  ├─ logs.ts          → Log file management                │ │
│  │  └─ paths.ts         → Config directory structure         │ │
│  └────────────────────────────────────────────────────────────┘ │
│                         │                                       │
│                         ▼                                       │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  ~/ .config/shepaw-hub/                                   │ │
│  │  ├─ hub.json                  [Project registry]         │ │
│  │  ├─ projects/<id>/                                       │ │
│  │  │  ├─ identity.json          [X25519 keypair]          │ │
│  │  │  ├─ authorized_peers.json  [Device pubkeys]          │ │
│  │  │  ├─ enrollments.json       [Pairing codes]           │ │
│  │  │  ├─ state.json             [Runtime state]           │ │
│  │  │  └─ logs/agent.log                                   │ │
│  │  └─ All files: mode 0600 (owner-only readable)          │ │
│  └────────────────────────────────────────────────────────────┘ │
│                         │                                       │
│                         ▼                                       │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Gateway Child Processes (per project)                    │ │
│  │  ├─ codebuddy                                            │ │
│  │  ├─ claude-code        } Spawned as separate processes   │ │
│  │  ├─ codex              } with env vars injected          │ │
│  │  └─ opencode           } from encrypted hub config       │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                 │
└──────────────────────────────────────────────────────────────────┘
```

---

## Agent Detail Page Component Tree

```
ProjectDetail (776 lines)
│
├─ State Management (30+ useState hooks)
│  ├─ project: Project | null
│  ├─ peers: Peer[]
│  ├─ envMasked: Record<string, string>
│  ├─ showEdit, showEnroll, showResume: boolean
│  ├─ edit* (form fields): string, boolean
│  ├─ env* (env var editing): Record<string, string>
│  ├─ addPeer* (peer management): string, string
│  └─ Various error states
│
├─ Effects
│  └─ useEffect(load, [projectId])
│
├─ Event Handlers
│  ├─ toggle() → start/stop project
│  ├─ openEdit(p) → populate edit form
│  ├─ submitEdit(e) → patch project config
│  ├─ saveEnvVar(key) → update credential
│  ├─ deleteEnvVar(key) → remove credential
│  ├─ addPeer(e) → add authorized device
│  ├─ removePeer(fp) → revoke device
│  └─ removeProject() → delete project
│
└─ UI Sections
   ├─ Header
   │  ├─ Status indicator + title
   │  └─ Action buttons (Start/Stop/Pair/Edit/Remove)
   │
   ├─ Edit Form (conditional)
   │  ├─ Project metadata fields
   │  ├─ Tunnel configuration section
   │  └─ Save/Cancel buttons
   │
   ├─ Info Grid (read-only)
   │  ├─ Bind address
   │  ├─ Working directory
   │  ├─ Base URL
   │  ├─ Status & timestamps
   │  └─ Creation date
   │
   ├─ Credentials Section (dynamic)
   │  └─ Engine-specific fields
   │     ├─ Display current (masked)
   │     ├─ Inline edit on demand
   │     └─ Save/Delete buttons per field
   │
   ├─ Tunnel Info (conditional)
   │  ├─ Server URL
   │  ├─ Channel ID
   │  └─ Secret (masked)
   │
   ├─ Logs Section
   │  └─ LogViewer component
   │     └─ WebSocket stream renderer
   │
   ├─ Peers Section
   │  ├─ Table of authorized devices
   │  ├─ Columns: fingerprint, label, addedAt, action
   │  ├─ Revoke button per peer
   │  └─ "Add Device" form (conditional)
   │
   ├─ EnrollModal (conditional)
   │  └─ Pairing code + QR code generation
   │
   └─ SessionResumeModal (conditional)
      └─ Session recovery dialog
```

---

## Data Flow: QR Code Generation to Device Pairing

```
┌─────────────────────────────────────────────────────────────────┐
│ USER INTERACTION                                               │
└─────────────────────┬───────────────────────────────────────────┘
                      │
                      ▼
        ┌──────────────────────────────┐
        │  ProjectDetail.tsx           │
        │  User clicks "Pair Device"   │
        │  setShowEnroll(true)         │
        └──────────────┬───────────────┘
                       │
                       ▼
        ┌──────────────────────────────────────┐
        │  EnrollModal.tsx                      │
        │  - Shows form                        │
        │  - Device label input               │
        │  - Tunnel URL input                 │
        └──────────────┬──────────────────────┘
                       │
                       ▼
        ┌─────────────────────────────────────────────────────────┐
        │  User fills form + clicks "Generate Pairing Code"      │
        │  mint() called:                                        │
        │  api.enroll.mint(projectId, {                          │
        │    ttlMinutes: 10,                                     │
        │    label: "My iPhone",                                 │
        │    baseUrl: "wss://tunnel.example.com"               │
        │  })                                                    │
        └──────────────┬────────────────────────────────────────┘
                       │
                       ▼ HTTPS POST to /api/projects/:id/enroll
┌─────────────────────────────────────────────────────────────────┐
│ BACKEND (api/routes/projects.ts)                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                │
│  projectsRouter.post('/:id/enroll', async (req, res) => {    │
│    1. Generate single-use code (Base32 alphanumeric)         │
│    2. Create enrollment record with 10-min TTL              │
│    3. Build QR payload JSON:                                │
│       {                                                      │
│         code: "ABC123DEF456...",                            │
│         url: "wss://host:port/enroll/:code",               │
│         agentId: "my-project",                             │
│         label: "My iPhone"                                 │
│       }                                                      │
│    4. JSON.stringify + URL-encode for QR                    │
│    5. Return EnrollToken:                                   │
│       {                                                      │
│         code: "ABC123DEF456...",                            │
│         display: "ABC123DEF456",                            │
│         qrPayload: "...json-encoded...",                    │
│         pairUrl: "wss://...",                               │
│         expiresAt: ISO8601 timestamp                        │
│       }                                                      │
│  })                                                          │
│                                                                │
└──────────────┬─────────────────────────────────────────────────┘
               │
               ▼ JSON response with EnrollToken
        ┌────────────────────────────────────────────────┐
        │  Frontend: api.enroll.mint() returns token    │
        │  setToken(t)  ← state update                 │
        │  Component re-renders                        │
        └──────────────┬─────────────────────────────────┘
                       │
                       ▼
        ┌───────────────────────────────────────────────┐
        │  EnrollModal renders token state:            │
        │  {token && (                                 │
        │    <div>                                     │
        │      <QRCodeSVG                              │
        │        value={token.qrPayload}  ◄────────┐   │
        │        size={200}                         │  │
        │        bgColor="#1e1e2e"                  │  │
        │        fgColor="#cdd6f4"                  │  │
        │        level="M"                          │  │
        │      />                                     │  │
        │      <code>{token.display}</code>         │  │
        │      <p>Or scan QR code ^</p>             │  │
        │    </div>                                  │  │
        │  )}                                         │  │
        └──────────────┬─────────────────────────────┘  │
                       │                                 │
                       ▼                                 │
        ┌─────────────────────────────────────┐         │
        │  qrcode.react library renders SVG   │         │
        │  from qrPayload JSON string ─────────┘        │
        │                                                 │
        │  <svg><path d="..." /></svg>                  │
        │  (200x200 pixels, high contrast)              │
        └─────────────────┬───────────────────┘
                          │
                          ▼
           ┌──────────────────────────────────┐
           │  QR code displayed to user       │
           │  + Manual code entry option      │
           │  + Expiration countdown          │
           └──────────────┬───────────────────┘
                          │
                          ▼
           ┌──────────────────────────────────────────────────┐
           │  Mobile app / scanner                           │
           │  1. Scans QR code image                        │
           │  2. Decodes qrPayload JSON                     │
           │  3. Opens enrollment URL with code             │
           │  4. Handshakes (X25519 key exchange)           │
           │  5. Device fingerprint generated               │
           └──────────────┬───────────────────────────────────┘
                          │
                          ▼ WebSocket or REST to enrollment URL
           ┌──────────────────────────────────────────────────┐
           │  Backend enrolls device                         │
           │  1. Validates code (not expired, not used)      │
           │  2. Stores public key in authorized_peers.json  │
           │  3. Invalidates code (single-use)              │
           │  4. Device can now authenticate to hub          │
           └──────────────────────────────────────────────────┘
                          │
                          ▼
           ┌──────────────────────────────────────────────────┐
           │  Frontend updates UI                            │
           │  1. Success notification                        │
           │  2. Peer appears in authorized devices list     │
           │  3. Device ready for encrypted communication    │
           └──────────────────────────────────────────────────┘
```

---

## Environment Variable Encryption Flow

```
┌─────────────────────────────────────┐
│  User enters API key in UI          │
│  "sk-ant-1234567890"                │
│  Clicks "Save"                      │
└──────────────┬──────────────────────┘
               │
               ▼
    ┌─────────────────────────────────────┐
    │  Frontend: api.envvars.set(        │
    │    projectId,                      │
    │    "ANTHROPIC_API_KEY",            │
    │    "sk-ant-1234567890"             │
    │  )                                  │
    │                                     │
    │  HTTPS POST /api/projects/:id/    │
    │    envvars/ANTHROPIC_API_KEY       │
    │  Body: { value: "sk-ant..." }      │
    └──────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────────┐
│  Backend: PUT /api/projects/:id/envvars/:key                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                │
│  1. Receive plaintext value: "sk-ant-1234567890"              │
│                                                                │
│  2. Encrypt with encryptValue():                              │
│     ├─ Uses hub root key (from .config/shepaw-hub/)          │
│     ├─ AES-256-GCM cipher                                   │
│     ├─ Random IV + authentication tag                        │
│     └─ Returns: "ENCRYPTED_BLOB_XYZ123..."                  │
│                                                                │
│  3. Store in project config (hub.json):                       │
│     projects[i].envVars["ANTHROPIC_API_KEY"] =                │
│       "ENCRYPTED_BLOB_XYZ123..."                              │
│                                                                │
│  4. Build credential hint (masked + encrypted):               │
│     ├─ Mask plaintext: "sk-a***7890"                         │
│     ├─ Store encrypted: "ENCRYPTED_BLOB_XYZ123..."           │
│     └─ Save to hub.json credentialHints                       │
│                                                                │
│  5. Return response: { ok: true, key: "ANTHROPIC_API_KEY" }  │
│                                                                │
│  ⚠️  Plaintext never persisted                               │
│  ⚠️  Only encrypted form stored                              │
│  ⚠️  Never returned to frontend                              │
│                                                                │
└──────────────┬───────────────────────────────────────────────┘
               │
               ▼
    ┌──────────────────────────────────────────────────────┐
    │  Frontend re-fetches project data                   │
    │  api.projects.get(projectId)                        │
    │  + api.envvars.list(projectId)                     │
    │                                                      │
    │  Receives:                                           │
    │  {                                                   │
    │    envVarKeys: ["ANTHROPIC_API_KEY", ...],         │
    │    status: { running: true, ... }                  │
    │  }                                                   │
    │  AND                                                 │
    │  {                                                   │
    │    key: "ANTHROPIC_API_KEY",                        │
    │    value: "sk-a***7890"    ◄──── MASKED            │
    │  }                                                   │
    └──────────────┬───────────────────────────────────────┘
                   │
                   ▼
    ┌──────────────────────────────────────┐
    │  UI updates envMasked state          │
    │  envMasked["ANTHROPIC_API_KEY"] =   │
    │    "sk-a***7890"                    │
    │                                      │
    │  Displays to user (masked)           │
    └──────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  Later: Gateway Process Spawned                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                │
│  1. Hub loads hub.json                                         │
│                                                                │
│  2. For each project env var:                                  │
│     ├─ Load encrypted blob                                    │
│     ├─ Decrypt with decryptValue():                           │
│     │  ├─ Use hub root key                                   │
│     │  ├─ Verify authentication tag                          │
│     │  └─ Returns plaintext: "sk-ant-1234567890"             │
│     └─ Add to child process env vars (only!)                 │
│                                                                │
│  3. Spawn gateway process with env vars:                       │
│     env ANTHROPIC_API_KEY="sk-ant-1234567890" \              │
│     /path/to/gateway serve --port 8090 ...                   │
│                                                                │
│  ⚠️  Plaintext only in memory during spawn                   │
│  ⚠️  Never written to disk after encryption                  │
│  ⚠️  Never appears in ps aux (env vars not in argv)          │
│                                                                │
└─────────────────────────────────────────────────────────────────┘
```

---

## Authentication & Device Pairing

```
┌─────────────────────────────────────┐
│  Hub Identity                       │
│  ~/.config/shepaw-hub/              │
│  projects/<id>/identity.json        │
│  {                                  │
│    publicKey: "base64...",  ◄────┐  │
│    privateKey: "base64..."  (X25519) │
│  }                                  │
└─────────────────────┬───────────────┘
                      │ Used for signing enrollment codes
                      │ and establishing trust
                      │
    ┌─────────────────┴──────────────────┐
    │                                    │
    ▼                                    ▼
┌─────────────────────┐     ┌──────────────────────┐
│  Device Enrollment  │     │  Authorized Peers    │
│                     │     │                      │
│ 1. Mobile app       │     │  Projects/           │
│    requests code    │     │  <id>/               │
│ 2. Code expires     │     │  authorized_peers.json
│    after 1st use    │     │  [                   │
│ 3. Device sends     │     │    {                 │
│    X25519 pubkey    │     │      pubkey: "...",  │
│ 4. Hub signs code   │     │      fingerprint:...,│
│    with private key │     │      label: "..."    │
│ 5. Handshake       │     │    }                 │
│    complete        │     │  ]                   │
│                     │     │                      │
│ Result: Device     │     │  On every request:   │
│ can now auth to    │     │  1. Device sends     │
│ hub using public   │     │     signature        │
│ key crypto         │     │  2. Hub verifies     │
│                     │     │     with stored key  │
└─────────────────────┘     │  3. Request allowed │
                            └──────────────────────┘
```

---

## Component Data Dependencies

```
App.tsx (98 lines)
  │
  ├─ useProjects hook
  │  ├─ api.projects.list()
  │  │  └─ Returns: Project[]
  │  │
  │  └─ Polling: refresh every 3s
  │
  ├─ ProjectCard (per project)
  │  ├─ Uses: project data
  │  └─ Calls:
  │     ├─ api.projects.start(id)
  │     └─ api.projects.stop(id)
  │
  └─ ProjectDetail (selected project)
     ├─ Parallel loads on mount:
     │  ├─ api.projects.get(id)
     │  ├─ api.peers.list(id)
     │  └─ api.envvars.list(id)
     │
     ├─ EnrollModal (modal within ProjectDetail)
     │  └─ Calls:
     │     └─ api.enroll.mint(id, options)
     │        └─ Returns: EnrollToken with qrPayload
     │           └─ Rendered by QRCodeSVG
     │
     ├─ LogViewer (WebSocket within ProjectDetail)
     │  └─ Opens:
     │     └─ ws://host:4000/ws/logs/:id?tail=50
     │        └─ Receives: { type: "data"|"error"|"end", text: "..." }
     │
     ├─ SessionResumeModal (modal within ProjectDetail)
     │  └─ For resuming previous conversations
     │
     └─ Various inline editors within ProjectDetail:
        ├─ EditForm: Updates project metadata
        ├─ Credentials: Edit individual env vars
        ├─ Peers: Add/remove authorized devices
        └─ Tunnel: Configure Channel Service tunnel
```

---

## File Mode & Security Permissions

```
~/.config/shepaw-hub/
│
├─ hub.json                          [Mode: 0600]
│  └─ Root project registry
│     ├─ Project list with metadata
│     ├─ Credential hints (masked + encrypted)
│     └─ Last tunnel server hint
│
├─ projects/
│  │
│  └─ {project-id}/                  [Mode: 0700]
│     │
│     ├─ identity.json               [Mode: 0600]
│     │  └─ X25519 keypair (private key!)
│     │
│     ├─ authorized_peers.json       [Mode: 0600]
│     │  └─ List of trusted device public keys
│     │
│     ├─ enrollments.json            [Mode: 0600]
│     │  └─ Outstanding pairing codes (10-min TTL)
│     │
│     ├─ state.json                  [Mode: 0644]
│     │  └─ Runtime state (PID, timestamps)
│     │
│     └─ logs/                       [Mode: 0700]
│        └─ agent.log                [Mode: 0644]
│           └─ Gateway process stderr/stdout
│
│  ⚠️  0600 = rw-------  (owner read/write only)
│  ⚠️  0700 = rwx------ (owner all permissions)
│  ⚠️  Not readable by other users
│  ⚠️  Not readable by other processes
│  ⚠️  Secrets protected at filesystem level
```

---

## Request/Response Flow Summary

```
CLIENT                              SERVER
  │                                   │
  ├─ GET /api/projects               │
  │────────────────────────────────►  │ List all agents
  │  ◄────────────────────────────────┤ Project[]
  │
  ├─ GET /api/projects/:id           │
  │────────────────────────────────►  │ Get one agent + status
  │  ◄────────────────────────────────┤ Project (envVarKeys only!)
  │
  ├─ POST /api/projects/:id/enroll   │
  │────────────────────────────────►  │ Generate pairing code + QR
  │  ◄────────────────────────────────┤ EnrollToken { qrPayload, ... }
  │
  │  [Frontend renders QRCodeSVG from token.qrPayload]
  │
  ├─ GET /api/projects/:id/peers     │
  │────────────────────────────────►  │ List authorized devices
  │  ◄────────────────────────────────┤ Peer[] { fingerprint, pubkey, ... }
  │
  ├─ PUT /api/projects/:id/envvars/KEY │
  │────────────────────────────────►  │ Set credential (plaintext)
  │  ◄────────────────────────────────┤ { ok: true, key: "KEY" }
  │
  │  [Server encrypts plaintext → AES-256-GCM → stored]
  │
  ├─ GET /api/projects/:id/envvars   │
  │────────────────────────────────►  │ List credentials (masked)
  │  ◄────────────────────────────────┤ { key, value (masked) }[]
  │
  ├─ WebSocket: /ws/logs/:id         │
  │─────────────────────────────────► │ Open log stream
  │  ◄─────────────────────────────── │ { type: "data", text: "..." }
  │  ◄─────────────────────────────── │ { type: "data", text: "..." }
  │  ◄─────────────────────────────── │ { type: "end" }
  │
  └─ POST /api/projects/:id/start    │
     ────────────────────────────────►  │ Spawn gateway process
      ◄────────────────────────────────┤ { pid, alreadyRunning }

```

