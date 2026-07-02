# Channel Proxy for External Network Connections - Complete Technical Guide

## Overview

The **Shepaw Agent Bridge** implements a sophisticated channel proxy system that enables agents running on private networks to be accessible from the internet without port forwarding. This guide provides a comprehensive technical reference.

---

## 1. System Architecture

### High-Level Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  INTERNET                                                                   │
│  ├─ Shepaw App (iOS/Android)                                              │
│  └─ Other Clients                                                          │
│       │                                                                     │
│       └─────── HTTPS/WSS ───────────────────────────────────────────┐      │
│                                                                      │      │
├──────────────────────────────────────────────────────────────────────┼──────┤
│                                                                      │      │
│  SHEPAW CHANNEL SERVICE (cloud relay)                              │      │
│  ├─ WebSocket listener: /tunnel/connect                           │      │
│  ├─ HTTP reverse proxy: /proxy/<channelId>/*                      │      │
│  ├─ WS multiplexing: streams identified by stream_id              │      │
│  └─ Auth: validates HMAC-SHA256 signature                         │      │
│       │                                                             │      │
│       └─── JSON tunnel protocol ─ (reverse WebSocket) ────┐       │      │
│                                                            │       │      │
├────────────────────────────────────────────────────────────┼───────┼──────┤
│                                                            │       │      │
│  PRIVATE NETWORK (firewall-protected)                     │       │      │
│                                                            │       │      │
│  ┌─────────────────────────────────────────────────────┐  │       │      │
│  │                                                     │  │       │      │
│  │  Shepaw Agent Hub                                  │  │       │      │
│  │  ├─ Core (config, spawn, crypto)                 │  │       │      │
│  │  ├─ API (Express REST)                           │  │       │      │
│  │  └─ UI (React/Vite web interface)                │  │       │      │
│  │                                                     │  │       │      │
│  │  [Hub spawns gateway with tunnel config]           │  │       │      │
│  │         │                                          │  │       │      │
│  └─────────┼──────────────────────────────────────────┘  │       │      │
│            │                                              │       │      │
│            ↓                                              │       │      │
│  ┌─────────────────────────────────────────────────────┐  │       │      │
│  │  Gateway Process (e.g., Claude Code)               │  │       │      │
│  │                                                     │  │       │      │
│  │  TunnelClient                                       │  │       │      │
│  │  ├─ Reads: PAW_ACP_TUNNEL_SERVER_URL             │  │       │      │
│  │  ├─ Reads: PAW_ACP_TUNNEL_CHANNEL_ID             │  │       │      │
│  │  ├─ Reads: PAW_ACP_TUNNEL_SECRET                 │  │       │      │
│  │  │                                                 │  │       │      │
│  │  ├─ Creates HMAC signature                        │  │       │      │
│  │  ├─ Connects to Channel Service                   │  │       │      │
│  │  ├─ Maintains persistent WebSocket               │  │       │      │
│  │  └─ Multiplexes HTTP/WS requests                 │  │       │      │
│  │                                                     │  │       │      │
│  │  ACPAgentServer                                    │  │       │      │
│  │  └─ Listens on 127.0.0.1:8080 (local)            │  │       │      │
│  │     ├─ /acp/ws (encrypted Noise protocol)         │  │       │      │
│  │     ├─ /health (diagnostics)                      │  │       │      │
│  │     └─ /... (agent endpoints)                     │  │       │      │
│  │                                                     │  │       │      │
│  └─────────────────────────────────────────────────────┘  │       │      │
│                                                            │       │      │
│  ┌─────────────────────────────────────────────────────┐  │       │      │
│  │ Per-Project Identity & Authorization               │  │       │      │
│  │                                                     │  │       │      │
│  │ ~/.config/shepaw-hub/projects/{id}/                │  │       │      │
│  │ ├─ identity.json (X25519 keypair)                │  │       │      │
│  │ ├─ authorized_peers.json (device public keys)    │  │       │      │
│  │ ├─ enrollments.json (pairing codes)              │  │       │      │
│  │ └─ state.json (PID, timestamps)                  │  │       │      │
│  │                                                     │  │       │      │
│  └─────────────────────────────────────────────────────┘  │       │      │
│                                                            │       │      │
└────────────────────────────────────────────────────────────┴───────┴──────┘
```

---

## 2. Request Flow (Step-by-Step)

### Scenario: Shepaw App sends a message to a remote agent

```
Step 1: USER ACTION
        Shepaw App on iPhone
        └─ User types message + sends
           
Step 2: ENCRYPTION & SUBMISSION
        Shepaw App
        └─ Encrypts with Noise Protocol
           └─ Sends to: wss://channel.example.com/proxy/ch_abc123/acp/ws

Step 3: CHANNEL SERVICE ROUTING
        Shepaw Channel Service
        ├─ Receives encrypted WebSocket frame
        ├─ Strips /proxy/ch_abc123 prefix
        ├─ Forwards as message type: "request"
        │  {
        │    type: "request",
        │    stream_id: 1,
        │    method: "POST",
        │    path: "/acp/ws",
        │    headers: { ... },
        │    body: "<base64-encrypted-noise-frame>"
        │  }
        └─ Sends over tunnel WebSocket to agent

Step 4: TUNNEL CLIENT RECEIVES
        TunnelClient (in agent gateway)
        ├─ Receives TunnelMessage via control WebSocket
        ├─ Identifies as WebSocket upgrade (path: /acp/ws)
        ├─ Calls forwardWsConnect()
        └─ Establishes local WebSocket to 127.0.0.1:8080

Step 5: LOCAL ROUTING
        ACPAgentServer (listening on 127.0.0.1:8080)
        ├─ Receives encrypted Noise frame
        ├─ Decrypts using agent identity private key
        ├─ Processes agent logic (on_chat callback)
        └─ Encrypts response
           └─ Sends response frame

Step 6: TUNNEL FORWARDING (REVERSE)
        TunnelClient receives response
        ├─ Encodes as base64
        ├─ Creates TunnelMessage type: "ws_data"
        ├─ Sends back over control WebSocket to Channel Service
        └─ Message format:
           {
             type: "ws_data",
             stream_id: 1,
             body: "<base64-response-frame>",
             ws_msg_type: 2  // binary
           }

Step 7: CHANNEL SERVICE RECEIVES
        Shepaw Channel Service
        ├─ Receives ws_data message on stream 1
        ├─ Decodes base64 body
        ├─ Forwards to connected Shepaw App WebSocket
        └─ App receives: encrypted Noise frame

Step 8: APP DECRYPTION
        Shepaw App
        ├─ Receives WebSocket frame
        ├─ Decrypts with peer public key
        ├─ Displays agent response to user
        └─ ✅ Complete!
```

---

## 3. Configuration Data Model

### Directory Structure

```
~/.config/shepaw-hub/
│
├── hub.json [mode 0600]
│   └─ {
│       version: 1,
│       projects: [
│         {
│           id: "my-project",
│           label: "My Agent",
│           engine: "claude-code",
│           cwd: "/home/user/my-project",
│           port: 8090,
│           host: "127.0.0.1",
│           baseUrl: "https://channel.example.com/proxy/ch_abc123",
│           extraArgs: ["--model", "opus-4-7"],
│           createdAt: "2024-05-08T10:00:00Z",
│           
│           // 🔗 TUNNEL CONFIGURATION
│           tunnel: {
│             serverUrl: "https://channel.example.com",
│             channelId: "ch_abc123",
│             secret: "hmac-sha256-secret" (encrypted!)
│           },
│           
│           // 🔐 CREDENTIALS
│           envVars: {
│             "ANTHROPIC_API_KEY": "encrypted(sk-ant-***)",
│             "ANTHROPIC_AUTH_TOKEN": "encrypted(...)"
│           }
│         }
│       ],
│       
│       // Hub-level metadata for pre-filling
│       lastTunnelServerUrl: "https://channel.example.com",
│       lastTunnelSecretHint: {
│         masked: "ch_sec***xyz",
│         encrypted: "..."
│       },
│       credentialHints: {
│         "claude-code": {
│           "ANTHROPIC_API_KEY": { masked: "sk-ant***789", encrypted: "..." }
│         }
│       }
│     }
│
└── projects/
    └── my-project/
        ├── identity.json [mode 0600]
        │   └─ X25519 keypair (agent's static key)
        │
        ├── authorized_peers.json [mode 0600]
        │   └─ Array of { publicKey, label, fingerprint }
        │
        ├── enrollments.json [mode 0600]
        │   └─ Array of { code, label, expiresAt, consumed }
        │
        ├── state.json
        │   └─ { pid: 12345, startedAt, stoppedAt, lastResult }
        │
        └── logs/
            └── agent.log (rotating, 7 segments)
```

---

## 4. Channel Tunnel Protocol

### Control WebSocket Connection

**Connect URL** (with HMAC authentication):
```
wss://channel.example.com/tunnel/connect
  ?channel_id=ch_abc123
  &timestamp=1715244000
  &nonce=a3f5b2c1d4e6f7g8
  &signature=<hmac-sha256-hex>
  &endpoint=my-api  (optional short-name alias)
```

**HMAC Signing** (never includes secret in URL):
```
signingString = `${channelId}\n${timestamp}\n${nonce}`
signature = HMAC-SHA256(secret, signingString).hex()
```

### Message Types

```typescript
// PING/PONG (keepalive every 20 seconds)
{ type: "ping" }
{ type: "pong" }

// HTTP FORWARDING
// Request (from Channel Service to Agent)
{
  type: "request",
  stream_id: 1,
  method: "POST",
  path: "/proxy/ch_abc123/acp/ws",
  headers: { "content-type": "application/octet-stream", ... },
  body: "base64-encoded-payload"
}

// Response (from Agent to Channel Service)
{
  type: "response",
  stream_id: 1,
  status: 200,
  headers: { "content-type": "application/octet-stream", ... },
  body: "base64-encoded-response"
}

// WEBSOCKET FORWARDING
// Open (from Channel Service)
{
  type: "ws_connect",
  stream_id: 2,
  path: "/proxy/ch_abc123/acp/ws",
  headers: { ... }
}

// Data (bidirectional)
{
  type: "ws_data",
  stream_id: 2,
  body: "base64-encoded-frame",
  ws_msg_type: 1  // 1 = text, 2 = binary
}

// Close (from either side)
{
  type: "ws_close",
  stream_id: 2
}

// SERVER-INITIATED CLOSE (secret rotated, etc.)
{
  type: "close"
}
```

---

## 5. Key Components Deep Dive

### 5.1 ChannelTunnelConfig (tunnel.ts)

```typescript
export interface ChannelTunnelConfigInit {
  serverUrl: string;        // "https://channel.example.com"
  channelId: string;        // "ch_abc123"
  secret: string;           // HMAC signing key
  channelEndpoint?: string; // Optional alias: "my-api"
  autoConnect?: boolean;    // Unused in Node SDK
}

export class ChannelTunnelConfig {
  // Load from environment (set by hub at spawn time)
  static fromEnv(env?: NodeJS.ProcessEnv): ChannelTunnelConfig | undefined
  
  // Fetch and cache channel alias
  static async createWithAliasLookup(init): Promise<ChannelTunnelConfig>
  
  // Get public endpoint for enrollment QRs
  getPublicEndpoint(opts: {agentId?, fingerprint?, publicKey?}): string
  // Returns: wss://channel.example.com/proxy/ch_abc123/acp/ws#fp=...&pk=...
  
  // Serialize to dict (for testing/serialization)
  toDict(): Record<string, unknown>
  static fromDict(d: Record<string, unknown>): ChannelTunnelConfig
}
```

### 5.2 TunnelClient (tunnel.ts)

```typescript
export class TunnelClient {
  constructor(opts: TunnelClientOptions)
  
  // Lifecycle
  async start(): Promise<void>      // Begin reconnect loop
  async stop(): Promise<void>       // Graceful shutdown
  
  // Private internals
  private async runLoop()           // Main reconnect + listen loop
  private connect(): Promise<void>  // Establish WS with HMAC auth
  private listen(): Promise<void>   // Main message dispatch
  
  // Forwarding logic
  private forwardHttp(req)          // HTTP request forwarding
  private forwardWsConnect(req)     // WebSocket upgrade
  private stripChannelPrefix(path)  // Strip /proxy/<id>/ or /c/<alias>/
  
  // Keepalive
  private startKeepalive()          // Send ping every 20s
  private stopKeepalive()
}
```

### 5.3 ACPAgentServer Integration (server.ts)

```typescript
export class ACPAgentServer {
  private tunnelConfig: ChannelTunnelConfig | undefined;
  private tunnelClient: TunnelClient | undefined;
  
  constructor(opts: ACPAgentServerOptions) {
    this.tunnelConfig = opts.tunnelConfig;
  }
  
  async run(opts: RunOptions = {}): Promise<void> {
    // Create HTTP server on 127.0.0.1:port
    
    if (this.tunnelConfig !== undefined) {
      this.tunnelClient = new TunnelClient({
        config: this.tunnelConfig,
        localHost: "127.0.0.1",
        localPort: opts.port || 8080,
        onLog: (line) => console.log(line),
      });
      await this.tunnelClient.start();
      
      const publicUrl = this.tunnelConfig.getPublicEndpoint({
        agentId: this.agentId,
        fingerprint: this.identity.fingerprint,
        publicKey: this.identity.publicKey,
      });
      console.log(`[Tunnel] Public endpoint: ${publicUrl}`);
    }
  }
  
  async runWithTunnel(tunnelConfig: ChannelTunnelConfig, opts: RunOptions = {}): Promise<void> {
    this.tunnelConfig = tunnelConfig;
    return this.run(opts);
  }
}
```

---

## 6. UI Configuration Screens

### AddProjectModal Component

```
┌─────────────────────────────────────────────────────────┐
│  Add Project                                        [✕]  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ID *                                                   │
│  [my-project________________________]                   │
│                                                         │
│  Label                                                  │
│  [My Project________________________]                   │
│                                                         │
│  Engine *                                               │
│  [v] claude-code                                        │
│                                                         │
│  Working Directory *                                    │
│  [/home/user/my-project____________]                   │
│                                                         │
│  Bind Host                                              │
│  [v] 127.0.0.1 (loopback only)                         │
│      0.0.0.0 (all interfaces)                          │
│                                                         │
│  Base URL (optional — auto-derived from tunnel)        │
│  [_______________________________]                     │
│                                                         │
│  ─────────────────────────────────────────────────     │
│  ▶ Tunnel Configuration (Shepaw Channel Service)        │
│  ─────────────────────────────────────────────────     │
│                                                         │
│  {when expanded}                                        │
│                                                         │
│  Configure a Shepaw Channel Service tunnel so the      │
│  agent is reachable remotely. All three fields are     │
│  required together.                                     │
│                                                         │
│  Server URL                                             │
│  [reused from last session]                            │
│  [https://channel.example.com_____]                    │
│                                                         │
│  Channel ID                                             │
│  [ch_abc123________________________]                    │
│                                                         │
│  Secret                         [Using: ch_sec***xyz]  │
│  [●●●●●●●●●●●●●]                                       │
│                                                         │
│  ─────────────────────────────────────────────────     │
│  Credentials (for claude-code)                          │
│  ─────────────────────────────────────────────────     │
│                                                         │
│  API Key *                      [Cached: sk-ant***789]  │
│  [Enter new value to override cached key_____]         │
│                                                         │
│  Auth Token (alternative)                              │
│  [__________________________________]                 │
│                                                         │
│  Base URL (custom endpoint)                             │
│  [__________________________________]                 │
│                                                         │
│  ─────────────────────────────────────────────────     │
│                                                         │
│  [Create Project]  [Cancel]                            │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### ProjectDetail Tunnel Section

```
┌────────────────────────────────────────────────────────┐
│  Tunnel Configuration                           [Edit] │
├────────────────────────────────────────────────────────┤
│                                                        │
│  Server URL                                            │
│  https://channel.example.com                          │
│                                                        │
│  Channel ID                                            │
│  ch_abc123                                             │
│                                                        │
│  Secret                                                │
│  ch_sec***xyz                                          │
│                                                        │
│  Public Base URL (auto-derived)                        │
│  https://channel.example.com/proxy/ch_abc123          │
│                                                        │
│  Status: ✅ Connected to Channel Service              │
│  Tunnel uptime: 2h 34m                                │
│                                                        │
└────────────────────────────────────────────────────────┘
```

---

## 7. API Endpoints

### Create Project with Tunnel

```
POST /api/projects
Content-Type: application/json

{
  "id": "my-project",
  "label": "My Project",
  "engine": "claude-code",
  "cwd": "/home/user/my-project",
  "host": "127.0.0.1",
  "port": 8090,
  "tunnel": {
    "serverUrl": "https://channel.example.com",
    "channelId": "ch_abc123",
    "secret": "hmac-sha256-key"
  },
  "envVars": {
    "ANTHROPIC_API_KEY": "sk-ant-..."
  }
}

Response: 201 Created
{
  "id": "my-project",
  "tunnel": {
    "serverUrl": "https://channel.example.com",
    "channelId": "ch_abc123",
    "secret": "hmac-sha256-key"
  },
  "baseUrl": "https://channel.example.com/proxy/ch_abc123",
  "status": {
    "running": false,
    "pid": null
  }
}
```

### Get Hub Metadata

```
GET /api/projects/meta

Response: 200 OK
{
  "lastTunnelServerUrl": "https://channel.example.com",
  "lastTunnelSecretHint": "ch_sec***xyz",
  "credentialHints": {
    "claude-code": {
      "ANTHROPIC_API_KEY": "sk-ant***789",
      "ANTHROPIC_AUTH_TOKEN": "eyJ***xyZ"
    }
  }
}
```

### Update Tunnel Configuration

```
PATCH /api/projects/:id
Content-Type: application/json

{
  "tunnel": {
    "serverUrl": "https://new-channel.example.com",
    "channelId": "ch_xyz789",
    "secret": "new-secret"
  }
}

Response: 200 OK
{
  "id": "my-project",
  "tunnel": { ... },
  "baseUrl": "https://new-channel.example.com/proxy/ch_xyz789",
  "status": { ... }
}
```

---

## 8. Encryption at Rest

### Hub Config Encryption

All sensitive values in hub.json are encrypted using AES-256-GCM:

```typescript
// Encryption (in crypto.ts)
function encryptValue(plaintext: string, root: string): string {
  // Derives key from ~/.config/shepaw-hub/master-key (or system keyring)
  // Uses AES-256-GCM with random IV
  // Returns: "base64(iv || ciphertext || auth_tag)"
}

// Decryption
function decryptValue(encrypted: string, root: string): string {
  // Reverse of above
}
```

**Why?**
- Protects tunnel secrets if hub.json is accidentally shared
- Protects API keys for agent credentials
- Key material never stored plaintext

---

## 9. Typical Deployment Scenarios

### Scenario 1: Development on Laptop

```
┌──────────────────┐
│  Shepaw App      │
│  (test device)   │
└────────┬─────────┘
         │ wss://localhost:8080/acp/ws
         │ (LAN)
         │
    ┌────┴──────────────────┐
    │  Laptop (firewall)     │
    │  ├─ Hub (port 4000)    │
    │  └─ Gateway (8080)     │
    └────────────────────────┘

Configuration:
- tunnel: not set
- host: 0.0.0.0 (or explicitly allow LAN)
- baseUrl: empty or manual "http://192.168.1.X:8080"
```

### Scenario 2: Production (Private Datacenter)

```
┌──────────────────┐
│  Shepaw App      │
│  (anywhere)      │
└────────┬─────────┘
         │ wss://channel.example.com/proxy/ch_abc123
         │ (internet + Channel Service)
         │
    ┌────┴────────────────────────────────┐
    │  Shepaw Channel Service (relay)      │
    └────────┬────────────────────────────┘
             │ (reverse tunnel WS)
             │
    ┌────────┴────────────────┐
    │  Private Datacenter     │
    │  (no inbound ports)     │
    │  ├─ Hub                 │
    │  └─ TunnelClient ────┐  │
    │     └─ Gateway (127.0.0.1:8080)
    └─────────────────────────┘

Configuration:
- tunnel.serverUrl: "https://channel.example.com"
- tunnel.channelId: "ch_abc123"
- tunnel.secret: "hmac-sha256-key"
- host: "127.0.0.1" (local only, tunnel is external)
- baseUrl: "https://channel.example.com/proxy/ch_abc123"
```

### Scenario 3: Hybrid (LAN + Internet Fallback)

```
Configuration:
- host: "0.0.0.0" (allow both LAN and tunnel)
- tunnel.serverUrl: "https://channel.example.com"
- tunnel.channelId: "ch_abc123"
- tunnel.secret: "..."

Shepaw App behavior:
- On LAN: Use direct connection (lower latency)
- Off LAN: Use tunnel through Channel Service
```

---

## 10. Troubleshooting

### Tunnel Not Connecting

**Symptoms**: Gateway logs show "Connection error"

**Checks**:
1. Verify env vars are set:
   ```bash
   env | grep PAW_ACP_TUNNEL
   ```
2. Check Channel Service is reachable:
   ```bash
   curl https://channel.example.com/api/v1/channels/ch_abc123
   ```
3. Verify secret hasn't been rotated
4. Check firewall allows outbound HTTPS/WSS

### High Latency

**Possible Causes**:
- Many concurrent streams on one tunnel
- Large payloads being base64-encoded
- Channel Service geographic distance

**Mitigations**:
- Reduce keepalive overhead (currently 20s)
- Use connection pooling on client side
- Deploy Channel Service closer to users

### Secret Rotation

**Process**:
1. Get new secret from Channel Service
2. Update via UI or CLI:
   ```bash
   shepaw-hub project update my-project --tunnel-secret "new-secret"
   ```
3. Hub restarts gateway with new secret
4. TunnelClient reconnects with new HMAC signature

---

## 11. Security Considerations

### Threat Model

| Threat | Mitigation |
|--------|------------|
| Tunnel secret in plaintext | Encrypted at rest (AES-256-GCM), env var at runtime |
| Man-in-the-Middle on tunnel | WebSocket over TLS (wss://), HMAC signature on connect |
| Replay attack | Timestamp + nonce in HMAC signing |
| Unauthorized agent access | Noise IK handshake + authorized_peers allowlist |
| Secret exposure in logs | Masked display in UI (ch_sec***xyz) |
| Configuration file theft | File mode 0600 (owner read/write only) |

### Best Practices

1. **Rotate secrets regularly** (e.g., quarterly)
2. **Use strong Channel Service credentials** (32+ bytes)
3. **Monitor tunnel connection logs** for anomalies
4. **Restrict hub.json file access** to trusted users
5. **Keep Channel Service software updated**
6. **Use HTTPS for hub API** in production

---

## 12. Implementation Checklist

- [x] TunnelConfig data structure (config.ts)
- [x] HMAC-SHA256 authentication (tunnel.ts)
- [x] JSON tunnel protocol (tunnel.ts)
- [x] HTTP forwarding (tunnel.ts)
- [x] WebSocket multiplexing (tunnel.ts)
- [x] Keepalive mechanism (tunnel.ts)
- [x] Reconnection with backoff (tunnel.ts)
- [x] Environment variable injection (spawn.ts)
- [x] ACPAgentServer integration (server.ts)
- [x] UI project creation form (AddProjectModal.tsx)
- [x] UI tunnel configuration display (ProjectDetail.tsx)
- [x] REST API endpoints (projects.ts)
- [x] Credential hint caching (projects.ts)
- [x] Encryption at rest (crypto.ts)
- [x] Secret masking in UI
- [x] File permissions (0600)

---

## 13. Quick Reference

### File Locations

```
Core Implementation:
  agent-hub/core/src/config.ts       - TunnelConfig, ProjectConfig
  agent-hub/core/src/spawn.ts        - Env var injection
  
Protocol & Client:
  sdks/.../src/tunnel.ts             - TunnelClient, ChannelTunnelConfig
  sdks/.../src/server.ts             - ACPAgentServer integration
  
UI Components:
  agent-hub/ui/src/components/AddProjectModal.tsx
  agent-hub/ui/src/components/ProjectDetail.tsx
  
API Routes:
  agent-hub/api/src/routes/projects.ts
  
Encryption:
  agent-hub/core/src/crypto.ts       - AES-256-GCM functions
```

### Environment Variables (Set at Process Spawn)

```bash
PAW_ACP_TUNNEL_SERVER_URL=https://channel.example.com
PAW_ACP_TUNNEL_CHANNEL_ID=ch_abc123
PAW_ACP_TUNNEL_SECRET=hmac-sha256-key
PAW_ACP_TUNNEL_ENDPOINT=my-api  # optional alias
```

### Configuration Methods

```bash
# CLI
shepaw-hub project add my-project \
  --tunnel-server https://channel.example.com \
  --tunnel-channel-id ch_abc123 \
  --tunnel-secret "secret"

# UI
1. Open hub UI (http://localhost:4000)
2. Click "Add Project"
3. Expand "Tunnel Configuration"
4. Fill in Server URL, Channel ID, Secret
5. Click "Create Project"
```

---

**This completes the comprehensive channel proxy implementation guide. Refer to specific source files for implementation details.**
