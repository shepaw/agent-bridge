# Agent Hub - Data Model & Connection Information

## Complete Agent Data Model

```
┌─────────────────────────────────────────────────────────────────┐
│                     AGENT (Project)                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  IDENTITY                                                       │
│  ├─ id: string                  "my-project"                   │
│  ├─ label: string               "My Code Agent"                │
│  ├─ engine: AgentEngine         "claude-code" | "codebuddy"    │
│  └─ createdAt: ISO8601          "2024-05-08T..."               │
│                                                                 │
│  EXECUTION CONTEXT                                             │
│  ├─ cwd: string                 "/home/user/projects/agent"    │
│  ├─ port: number                8090                           │
│  ├─ host: string                "127.0.0.1" | "0.0.0.0"        │
│  ├─ baseUrl: string (optional)  "https://tunnel.example.com"   │
│  └─ extraArgs: string[]         ["--model", "opus-4-7"]        │
│                                                                 │
│  RUNTIME STATUS                                                │
│  ├─ running: boolean            true                           │
│  ├─ pid: number | null          12345                          │
│  ├─ startedAt: ISO8601 | null   "2024-05-08T10:00:00Z"        │
│  ├─ stoppedAt: ISO8601 | null   null                           │
│  └─ lastResult: string | null   "graceful" | "hard" | "crash" │
│                                                                 │
│  🔐 CREDENTIALS (ENCRYPTED)                                    │
│  └─ envVars: Record<string, ENCRYPTED_VALUE>                  │
│     ├─ "ANTHROPIC_API_KEY": "encrypted(sk-ant-***)"           │
│     ├─ "ANTHROPIC_AUTH_TOKEN": "encrypted(...)"               │
│     └─ "ANTHROPIC_BASE_URL": "encrypted(https://...)"         │
│                                                                 │
│     ⚠️  ONLY KEY NAMES returned by API (never values!)        │
│     ⚠️  Values encrypted at rest (AES-256-GCM)                │
│     ⚠️  Decrypted only at process spawn time                  │
│                                                                 │
│  🔗 TUNNEL (OPTIONAL)                                          │
│  └─ tunnel?: TunnelConfig                                      │
│     ├─ serverUrl: string        "https://channel.example.com"  │
│     ├─ channelId: string        "ch_abc123def456"              │
│     └─ secret: ENCRYPTED        "encrypted(hmac-sha256-key)"   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Credential Storage Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  ~/.config/shepaw-hub/                                        │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  hub.json                                                      │
│  ├─ projects: [ { id, label, engine, cwd, port, ... } ]      │
│  ├─ lastTunnelServerUrl: string                               │
│  ├─ lastTunnelSecretHint: { masked, encrypted }               │
│  └─ credentialHints:                                          │
│     └─ per-engine cache of masked credential values           │
│        ├─ "claude-code":                                      │
│        │  ├─ "ANTHROPIC_API_KEY": "sk-ant***789"             │
│        │  └─ "ANTHROPIC_AUTH_TOKEN": "eyJ***xyz"            │
│        └─ "codebuddy": { ... }                               │
│                                                                │
│  projects/                                                     │
│  └─ {project-id}/                                            │
│     ├─ identity.json              [X25519 keypair]           │
│     ├─ authorized_peers.json      [public keys of devices]   │
│     ├─ enrollments.json           [pairing codes]            │
│     ├─ state.json                 [PID, timestamps]          │
│     └─ logs/                                                  │
│        └─ agent.log               [stream of logs]           │
│                                                                │
│  ⚠️  hub.json, identity.json, authorized_peers.json          │
│      → File mode 0600 (owner read/write only)                 │
│      → Never readable by other users                          │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

## API Response Data Exposure

### `GET /api/projects/:id` - Detailed Agent View

```typescript
// Response: Project object
{
  id: "my-project",
  label: "My Agent",
  engine: "claude-code",
  cwd: "/path/to/project",
  port: 8090,
  host: "127.0.0.1",
  baseUrl: "https://tunnel.example.com",
  extraArgs: ["--model", "opus-4-7"],
  createdAt: "2024-05-08T10:00:00Z",
  
  // Tunnel config (including secret, but should be masked in UI!)
  tunnel: {
    serverUrl: "https://channel.example.com",
    channelId: "ch_abc123",
    secret: "hmac-sha256-secret-value"  // ⚠️  Raw value! UI should mask
  },
  
  // ⚠️  ONLY KEY NAMES, never values!
  envVarKeys: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL"
  ],
  
  status: {
    running: true,
    pid: 12345,
    startedAt: "2024-05-08T10:00:00Z",
    stoppedAt: null,
    lastResult: "graceful"
  }
}
```

### `GET /api/projects/:id/envvars` - Masked Credential View

```typescript
// Response: List of { key, value } where value is MASKED
[
  { key: "ANTHROPIC_API_KEY", value: "sk-ant***789" },
  { key: "ANTHROPIC_AUTH_TOKEN", value: "eyJ***xyZ" },
  { key: "ANTHROPIC_BASE_URL", value: "https://***m.com" }
]
```

### `POST /api/projects/:id/enroll` - Device Pairing

```typescript
// Request body
{
  ttlMinutes: 10,
  label: "My iPhone",
  baseUrl: "wss://proxy.example.com"
}

// Response: EnrollToken
{
  code: "BASE32ABC123DEF456",
  display: "ABC123DEF456",  // formatted for display
  label: "My iPhone",
  expiresAt: "2024-05-08T10:10:00Z",
  pairUrl: "wss://host:port/enroll/ABC123DEF456",
  qrPayload: "{\"code\":\"ABC123DEF456\",\"url\":\"wss://...\"}",
  agentId: "my-project",
  fingerprint: "fingerprint-of-enrolled-device"
}
```

## Environment Variables by Engine

### codebuddy
```
CODEBUDDY_API_KEY      (required)
CODEBUDDY_AUTH_TOKEN   (optional)
```

### claude-code
```
ANTHROPIC_API_KEY           (required)
ANTHROPIC_AUTH_TOKEN        (optional, alternative auth)
ANTHROPIC_BASE_URL          (optional, custom endpoint)
```

### codex (OpenAI)
```
OPENAI_API_KEY              (required)
OPENAI_BASE_URL             (optional, custom endpoint)
```

### opencode
```
(no standard credentials)
```

## Secret Masking Display Function

```typescript
function maskSecretValue(secret: string): string {
  if (!secret) return '';
  const len = secret.length;
  if (len <= 4) return '*'.repeat(len);
  
  // Show first 1/3, hide middle, show last 1/4
  const headLen = Math.min(4, Math.floor(len / 3));
  const tailLen = Math.min(4, Math.floor(len / 4));
  const head = secret.slice(0, headLen);
  const tail = secret.slice(len - tailLen);
  return `${head}***${tail}`;
}

// Examples:
// "sk-ant-1234567890" → "sk-a***7890"
// "short" → "*****"
// "x" → "*"
```

## Data Flow: Adding/Updating Credentials

```
UI (ProjectDetail.tsx)
    │
    ├─ User clicks "Update" for ANTHROPIC_API_KEY
    │
    ├─ Opens inline edit with input field
    │ (displays: "sk-ant***789" as placeholder/initial value)
    │
    ├─ User types new value: "sk-ant-1234567890"
    │
    ├─ User clicks "Save"
    │
    └─ POST /api/projects/:id/envvars/ANTHROPIC_API_KEY
        └─ Body: { value: "sk-ant-1234567890" }
            │
            Backend (projects.ts)
            │
            ├─ Encrypts with AES-256-GCM
            │
            ├─ Stores encrypted in hub.json
            │
            ├─ Updates credential hints cache (masked + encrypted)
            │
            └─ Returns: { ok: true, key: "ANTHROPIC_API_KEY" }
                │
                UI
                │
                ├─ Reloads project data
                │
                └─ Displays success, updates envMasked map
                   (envMasked["ANTHROPIC_API_KEY"] = "sk-ant***890")
```

## Device Pairing Flow with QR

```
┌─────────────────────────────────────────────────────────┐
│  User clicks "Pair Device"                              │
└─────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────┐
│  EnrollModal opens                                       │
│  - Device label: "My iPhone"                            │
│  - Tunnel URL: "wss://tunnel.example.com"              │
│  - User clicks "Generate Pairing Code"                  │
└─────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────┐
│  POST /api/projects/:id/enroll                          │
│  Backend generates:                                      │
│  - Single-use code (10 min TTL)                         │
│  - QR payload JSON: { code, url, agentId }             │
│  - Pairing URL: wss://host:port/enroll/:code           │
└─────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────┐
│  Frontend displays EnrollToken                          │
│  - QR Code (from token.qrPayload)                       │
│    ├─ QRCodeSVG component                              │
│    ├─ Size: 200px                                      │
│    ├─ Colors: Catppuccin theme                         │
│    └─ Error correction: M                              │
│  - Manual code entry: "ABC123DEF456"                   │
│  - Expiration countdown: "9 min 58 sec left"           │
└─────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────┐
│  Mobile app scans QR                                    │
│  - Extracts qrPayload JSON                             │
│  - Opens pairing handshake                             │
│  - Exchanges X25519 keys                               │
└─────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────┐
│  Hub adds device (Peer)                                 │
│  - Stores public key in authorized_peers.json          │
│  - Computes fingerprint                                │
│  - Code is invalidated                                 │
│  - Device now trusted for encrypted communication      │
└─────────────────────────────────────────────────────────┘
```

## UI Components - Data Dependencies

```
App.tsx
  ├─ ProjectCard
  │  └─ api.projects.list()
  │     ├─ project.id
  │     ├─ project.label
  │     ├─ project.engine
  │     ├─ project.host:port
  │     └─ project.status.running
  │
  └─ ProjectDetail
     ├─ api.projects.get(id)
     │  ├─ id, label, engine
     │  ├─ cwd, host, port, baseUrl
     │  ├─ envVarKeys (only keys!)
     │  ├─ tunnel config
     │  └─ status
     │
     ├─ api.peers.list(id)
     │  ├─ fingerprint
     │  ├─ pubkey
     │  ├─ label
     │  └─ addedAt
     │
     ├─ api.envvars.list(id)
     │  ├─ key (always)
     │  └─ value (masked display)
     │
     ├─ EnrollModal
     │  └─ api.enroll.mint(id)
     │     ├─ code
     │     ├─ qrPayload (for QRCodeSVG)
     │     ├─ pairUrl
     │     └─ expiresAt
     │
     └─ LogViewer
        └─ ws://host:port/ws/logs/:id
           └─ Real-time log stream
```

## Security Considerations

| Component | Security Level | Details |
|-----------|--|---------|
| **envVarKeys** | 🟢 Safe to expose | Only names, never values |
| **envVar values** | 🔴 Never expose | Always encrypted at rest |
| **tunnel.secret** | 🟡 Masked in UI | Raw value in API response, UI should mask |
| **baseUrl** | 🟢 Public | Externally accessible URL |
| **qrPayload** | 🟡 Temporary | Single-use, expires in 10 min |
| **peerPublicKey** | 🟢 Public | By definition (public key) |
| **device fingerprint** | 🟢 Safe to expose | Derived from public key, for identification |
| **cwd** | 🟡 Infrastructure data | Local paths (restricted to file mode 0600) |

