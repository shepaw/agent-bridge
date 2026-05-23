# Shepaw Agent-Bridge/Agent-Hub - Documentation Index

## Overview

This directory contains comprehensive documentation of the **Shepaw Agent Hub** monorepo, created through detailed codebase exploration focused on project structure, agent detail page implementation, connection information storage, QR code implementation, and frontend technology stack.

---

## 📚 Documentation Files

### 🎯 Start Here: EXPLORATION_SUMMARY.md (10 KB)
**Quick reference covering all five exploration areas**
- Project structure overview
- Frontend technology stack at a glance
- Agent data available in the system
- QR code implementation summary
- Key findings and patterns
- Development setup instructions
- Security considerations
- Quick file locations reference

**Best for:** Getting oriented quickly, understanding high-level architecture

---

### 🏗️ CODEBASE_EXPLORATION.md (14 KB)
**Comprehensive overview of the entire codebase structure**
- Complete directory tree layout
- Detailed file-by-file breakdown
- Component hierarchy and dependencies
- API endpoint documentation
- State management patterns
- Routing implementation
- Data flow overview
- Development scripts and tools

**Best for:** Deep understanding of project organization, understanding how files relate

---

### 💾 AGENT_DATA_MODEL.md (16 KB)
**Deep dive into agent data structures and credential handling**
- Complete `Project` interface specification
- `EnrollToken` interface for device pairing
- `ProjectStatus` and `TunnelConfig` types
- Credential storage architecture (at rest and in transit)
- Environment variables by engine type
- Secret masking algorithm explanation
- API response examples
- Data flow diagrams
- Security matrix for different data types

**Best for:** Understanding agent data, credential security, API contracts

---

### 🔐 QR_CODE_IMPLEMENTATION_GUIDE.md (11 KB)
**Technical guide for QR code implementation**
- Current `qrcode.react` library details
- `QRCodeSVG` component props reference
- Implementation context and usage patterns
- Catppuccin color theme reference
- Examples from production code (EnrollModal.tsx)
- Data flow for device pairing
- Security notes for QR payloads
- Troubleshooting guide
- Enhancement ideas and possibilities

**Best for:** Implementing or modifying QR code features, understanding device pairing flow

---

### 🔍 ARCHITECTURE_DIAGRAMS.md (36 KB)
**Visual representations of system architecture**
- System component architecture diagram
- React component tree visualization
- Data flow diagrams
- Authentication and device pairing flow
- Component data dependency diagram
- File permissions matrix
- Environment variable encryption flow
- Color-coded security levels

**Best for:** Visual learners, system design documentation

---

## 📖 Additional Reference Files

### TECHNICAL_REFERENCE.md (15 KB)
Detailed technical specifications, type definitions, and implementation patterns.

### SECURITY.md (14 KB)
Security best practices, encryption details, and credential handling.

### AUDIT_REPORT.md (14 KB)
Initial audit findings and recommendations.

### IMPLEMENTATION_GUIDE.md (7 KB)
Quick implementation guide for common tasks.

---

## 🎓 Learning Paths

### Path 1: "I want to understand the architecture"
1. Read: `EXPLORATION_SUMMARY.md` (5 min)
2. View: `ARCHITECTURE_DIAGRAMS.md` (5 min)
3. Read: `CODEBASE_EXPLORATION.md` (10 min)

**Time: ~20 minutes**

---

### Path 2: "I want to work with agent data"
1. Read: `EXPLORATION_SUMMARY.md` → "Agent Data Available" section (2 min)
2. Read: `AGENT_DATA_MODEL.md` (10 min)
3. Reference: Type definitions in relevant `.ts` files as needed

**Time: ~12 minutes**

---

### Path 3: "I want to implement QR code features"
1. Read: `EXPLORATION_SUMMARY.md` → "QR Code Implementation" section (2 min)
2. Read: `QR_CODE_IMPLEMENTATION_GUIDE.md` (10 min)
3. Reference: `EnrollModal.tsx` implementation (5 min)

**Time: ~17 minutes**

---

### Path 4: "I want to understand credential security"
1. Read: `EXPLORATION_SUMMARY.md` → "Credential Security" section (2 min)
2. Read: `AGENT_DATA_MODEL.md` → "Credential Storage" sections (5 min)
3. Read: `SECURITY.md` for detailed security practices (5 min)

**Time: ~12 minutes**

---

## 🚀 Quick Facts

### Frontend Technology Stack
- **Framework**: React 19.1.0
- **Bundler**: Vite 5.4.0
- **Language**: TypeScript 5.7.2
- **QR Library**: qrcode.react 4.2.0
- **UI Components**: None (custom inline CSS-in-JS)
- **Styling**: Catppuccin theme (hardcoded)
- **State Management**: React hooks only (no Redux/Zustand)

### Project Structure
```
agent-bridge/agent-hub/
├── core/    → Business logic & configuration management
├── api/     → Express REST API (port 4000)
├── ui/      → React dashboard (Vite dev: 5173, proxies to :4000)
└── cli/     → CLI binary for project management
```

### Key Agent Information
- **Public**: ID, label, engine type, host, port, baseUrl, status
- **Infrastructure**: Working directory, extra args, tunnel config
- **Credentials**: Only KEY NAMES are exposed (values encrypted at rest)
- **Storage**: AES-256-GCM encryption with file permissions 0600

### QR Code Features
- **Library**: qrcode.react (lightweight SVG-based)
- **Use Case**: Device pairing/enrollment
- **Payload**: Backend-generated JSON (single-use, 10-min TTL)
- **Display**: Catppuccin-themed colors in EnrollModal

---

## 📋 File Locations

| Component | File | Lines | Purpose |
|-----------|------|-------|---------|
| Router | `ui/src/App.tsx` | 98 | Hash-based routing (#project/:id) |
| Agent Detail | `ui/src/components/ProjectDetail.tsx` | 776 | Main agent management interface |
| QR Modal | `ui/src/components/EnrollModal.tsx` | 237 | Device pairing QR code display |
| Card | `ui/src/components/ProjectCard.tsx` | 119 | Grid item in project list |
| REST Client | `ui/src/api/client.ts` | 89 | Simple fetch wrapper |
| Types | `ui/src/api/types.ts` | 101 | TypeScript interfaces |
| Hooks | `ui/src/hooks/useProjects.ts` | ? | Data fetching hook |
| Utilities | `ui/src/utils/maskSecret.ts` | ? | Credential masking |

---

## 🔗 Dependencies

### Production Dependencies
- react: ^19.1.0
- react-dom: ^19.1.0
- qrcode.react: ^4.2.0

### Dev Dependencies
- vite: ^5.4.0 (overridden from 5.3.1 in root)
- typescript: ^5.7.2
- @vitejs/plugin-react: ^4.3.4

### Backend Dependencies
- express.js (REST API)
- WebSocket support (log streaming)
- AES-256-GCM encryption

---

## 🔐 Security Summary

| Aspect | Status | Details |
|--------|--------|---------|
| Credential Encryption | ✅ Strong | AES-256-GCM at rest |
| API Exposure | ✅ Strong | Only key names, never values |
| UI Display | ✅ Good | Masked values (e.g., "sk-ant***789") |
| File Permissions | ✅ Strong | 0600 (owner-only readable) |
| QR Codes | ✅ Strong | Single-use tokens with 10-min TTL |
| Session Data | ✅ Strong | No localStorage/sessionStorage |

---

## 💡 Key Architectural Patterns

### Pattern 1: Sentinel Values
Prevents re-transmission of unchanged secrets while showing masked values:
```typescript
const TUNNEL_SECRET_UNCHANGED = '\x00unchanged';
// Pre-fill with sentinel when editing
// On save, only send to API if changed
```

### Pattern 2: Component Composition
Hierarchical component structure from router → detail → modals

### Pattern 3: Async Error Handling
Standard pattern: `[busy, error] = useState()` with try/catch/finally

### Pattern 4: Hash-Based Routing
Simple location.hash implementation with hashchange event listener

---

## 🎯 Recommendations

### For QR Code Enhancement (Low Effort)
- [ ] Add download/print button for QR code
- [ ] Display countdown timer to code expiration
- [ ] Add copy-to-clipboard for manual code entry
- [ ] Larger QR size option for accessibility

### For Data Security
- [ ] Consider masking `tunnel.secret` in API responses
- [ ] Add audit logging for credential access

### For Developer Experience (If App Scales)
- [ ] Add React Query for data fetching/caching
- [ ] Consider Headless UI or Radix for component library
- [ ] Migrate to CSS/Tailwind if inline styles become unmanageable

---

## 📞 Getting Help

Each documentation file is self-contained and includes:
- Code examples
- Type definitions
- Data flow diagrams
- Security notes
- Implementation patterns
- Troubleshooting guidance

Use the Learning Paths section above to find the right starting point for your task.

---

## 📅 Exploration Metadata

- **Exploration Date**: May 8, 2026
- **Codebase Location**: `/Users/edenzou/workspace/shepaw/agent-bridge/`
- **Monorepo Structure**: npm workspaces (core, api, ui, cli)
- **Primary Focus**: Agent Hub UI (React + TypeScript)

---

*Last updated: May 8, 2026*
