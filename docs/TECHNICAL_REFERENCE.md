# Shepaw Agent Bridge — Technical Reference

## SDK Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  Shepaw App (Phone)                                     │
│  - User sends messages                                  │
│  - Receives `/` palette slash commands                  │
│  - Shows forms, confirmations, collapsible blocks       │
└──────────────────┬──────────────────────────────────────┘
                   │ (WebSocket ACP protocol)
                   │
┌──────────────────▼──────────────────────────────────────┐
│  ACPAgentServer (shepaw-acp-sdk-typescript)             │
│  - Handles WebSocket connections                        │
│  - Routes JSON-RPC requests                             │
│  - Manages task lifecycle (start/complete/error)        │
│  - Registers slash commands via SlashCommandRegistry    │
└──────┬───────────────────┬──────────────┬───────────────┘
       │                   │              │
    onChat()          onCommandsList()    onModelsSetCurrent()
       │                   │              │
       ▼                   ▼              ▼
┌──────────────┐ ┌──────────────────┐ ┌────────────────┐
│ Agent        │ │ Registry         │ │ Models         │
│ .query()     │ │ .dispatch()      │ │ Provider       │
│              │ │                  │ │                │
│ Returns:     │ │ Handlers:        │ │ Returns:       │
│ - text       │ │ - /model         │ │ - Model list   │
│ - tool_use   │ │ - /status        │ │ - Current      │
│ - reasoning  │ │ - /mcp           │ │                │
│ (partial)    │ │ - /permissions   │ │                │
└──────────────┘ └──────────────────┘ └────────────────┘
       │                   │              │
       └───────────────────┴──────────────┘
                   │
                   ▼
         ┌─────────────────────┐
         │  TaskContext        │
         │  - sendText()       │
         │  - sendForm()       │
         │  - sendActionConf.()│
         │  - completed()      │
         │  - error()          │
         └─────────────────────┘
```

---

## TaskContext API Reference

### Streaming Output

```typescript
// Stream text incrementally (called multiple times)
await ctx.sendText("Hello, ");
await ctx.sendText("world!");

// Mark text block as final
await ctx.sendTextFinal();  // Signals no more text coming
```

**Wire format:** `ui.textContent` notification
```json
{
  "jsonrpc": "2.0",
  "method": "ui.textContent",
  "params": {
    "task_id": "abc123",
    "content": "Hello, world!",
    "is_final": false
  }
}
```

---

### Interactive Components (Async, Non-Blocking)

All of these return immediately; the user's response arrives **later as a new `agent.chat` message**.

#### Action Confirmation
```typescript
const confirmId = await ctx.sendActionConfirmation({
  prompt: "Run npm build?",
  actions: [
    { label: "Allow", value: "allow" },
    { label: "Deny", value: "deny" },
  ],
  confirmationId: "confirm_build_123",  // optional; auto-generated if omitted
});
// User taps "Allow" or "Deny" → arrives as "Allow" or "Deny" string in next agent.chat
```

#### Forms
```typescript
const formId = await ctx.sendForm({
  title: "Enter deployment config",
  description: "Fill in the details",
  fields: [
    {
      name: "environment",
      label: "Environment",
      type: "radio_group",
      required: true,
      options: [
        { label: "Staging", value: "staging" },
        { label: "Production", value: "prod" },
      ],
    },
    {
      name: "confirmation",
      label: "I understand the risks",
      type: "checkbox_group",
      required: true,
      options: [{ label: "Yes", value: "yes" }],
    },
  ],
  formId: "form_deploy_123",  // optional; auto-generated if omitted
});
// User submits → arrives as "Form submitted: environment: staging\nconfirmation: yes" in next agent.chat
```

#### File Upload
```typescript
const uploadId = await ctx.sendFileUpload({
  prompt: "Upload your project tarball",
  acceptTypes: ["application/gzip", "application/x-tar"],
  maxFiles: 1,
  maxSizeMb: 100,
  uploadId: "upload_tar_123",  // optional
});
// User uploads file → metadata arrives in next agent.chat
```

---

### Metadata (Styling)

```typescript
// Add a collapsible header before streaming text
await ctx.sendMessageMetadata({
  collapsible: true,
  collapsibleTitle: "$ npm build output",
  autoCollapse: true,  // Collapsed by default; user can expand
});
await ctx.sendText("Building...\n");
await ctx.sendText("Done!");
```

**Use case:** Group command output, file lists, logs under a collapsible header.

---

### Task Lifecycle

```typescript
// Send explicit lifecycle notifications (optional; some flows may use defaults)

// Mark task as started
await ctx.started();  // Sends task.started notification

// Mark task as successfully completed
await ctx.completed();  // Sends task.completed notification

// Mark task as failed
await ctx.error("Build failed: exit code 1", -32603);  // Sends task.error notification
```

**Default flow (via onChat override):**
1. Task enters `onChat(ctx)`
2. Agent sends text, forms, etc.
3. Agent returns (success)
4. SDK auto-sends `ctx.sendTextFinal()` + `ctx.completed()`
5. Task ends

**Custom flow (explicit lifecycle):**
```typescript
override async onChat(ctx, msg) {
  await ctx.started();
  try {
    // ... do work ...
    await ctx.sendText("Done!");
    await ctx.sendTextFinal();
    await ctx.completed();
  } catch (err) {
    await ctx.error(err.message);
  }
}
```

---

### Hub Requests (Agent → App)

Request data from the Shepaw app (rare; mostly for apps that store per-user settings):

```typescript
// Request JSON-RPC method from app; wait for response
const userData: any = await ctx.hubRequest('user.profile', {}, { timeoutMs: 5000 });

// Similar to:
// POST /acp/rpc
// { "jsonrpc": "2.0", "method": "user.profile", "id": "xyz", "params": {} }
// Response: { "jsonrpc": "2.0", "result": {...}, "id": "xyz" }
```

---

## SlashCommandRegistry API

### Registering Handlers

```typescript
import {
  SlashCommandRegistry,
  createModelHandler,
  createStatusHandler,
  createMcpHandler,
  createPermissionsHandler,
} from 'shepaw-acp-sdk';

const registry = new SlashCommandRegistry<AgentCfg>();

// Built-in handlers
registry.register(
  createModelHandler<AgentCfg>({
    applyModel: (cfg, modelId, models) => {
      cfg.model = modelId;
      // ... persist or notify hooks ...
      return models.find(m => m.id === modelId);
    },
  }),
);

registry.register(createStatusHandler<AgentCfg>());
registry.register(createMcpHandler<AgentCfg>());
registry.register(
  createPermissionsHandler<AgentCfg>({
    applyMode: (cfg, modeId, modes) => {
      cfg.permissionMode = modeId;
      return modes.find(m => m.id === modeId);
    },
  }),
);
```

### Custom Handlers

```typescript
const registry = new SlashCommandRegistry<AgentCfg>();

registry.register({
  name: 'logs',
  aliases: ['log', 'tail'],
  description: 'Show recent agent logs',
  argumentHint: '[--lines N]',
  async handle(ctx, args, raw, kwargs, deps) {
    // args = tokenized arguments (e.g., ['--lines', '10'])
    // raw = full trimmed message after "/" (e.g., 'logs --lines 10')
    // deps = { cfg, providers, registerFormHandler }
    
    const lines = args[0] === '--lines' ? parseInt(args[1]) : 20;
    const logs = await readLogs(lines);
    
    await ctx.sendText(`\`\`\`\n${logs}\n\`\`\``);
    return true;  // Handled; skip onChat
  },
});
```

---

## Agent Implementations: Key Differences

### Codex

**File:** `implementations/codex-ts/src/agent.ts`

**Event Stream:** Codex exposes rich events (reasoning, todo lists, web search, MCP tool calls)

**Key lines:**
- Lines 352-363: Run query, stream events
- Lines 373-428: Handle thread events (turned, item.started, item.updated, item.completed)
- Lines 455-462: Handle reasoning items → stream as italic text
- Lines 463-472: Handle todo_list items → render task list
- Lines 522-528: Handle MCP tool calls → render status

**Limitations:**
- No async confirmation (approvalPolicy only)
- No permission mode switching

---

### Claude Code

**File:** `implementations/claude-code-ts/src/agent.ts`

**Event Stream:** Claude SDK sends assistant messages and tool_use blocks

**Key lines:**
- Lines 559-567: Create canUseTool callback (async confirmation)
- Lines 582-590: Stream query with async user prompt
- Lines 593-646: Handle SDK messages (system init, assistant content, result)
- Lines 663-691: Merge slash commands from SDK, registry, and filesystem

**Features:**
- ✅ Async tool confirmation
- ✅ Permission mode switching
- ❌ Thinking blocks not exposed

---

### CodeBuddy

**File:** `implementations/codebuddy-code/src/agent.ts`

**Event Stream:** Tencent SDK sends assistant messages and tool_use blocks (very similar to Claude)

**Key lines:**
- Lines 471-479: Create canUseTool callback (same pattern as Claude Code)
- Lines 493-501: Stream query with async user prompt
- Lines 504-555: Handle SDK messages (system init, assistant content, result)

**Features:**
- ✅ Async tool confirmation
- ⚠️ Permission mode switching (registered but SDK may not support it)

---

### OpenCode

**File:** `implementations/opencode-ts/src/commands/registry.ts`

**Features:**
- ✅ `/model` picker
- ✅ `/status` command
- ✅ `/mcp` command
- ❌ `/permissions` (not registered)

**Status:** Minimal implementation; full agent not audited in detail.

---

## Provider Interfaces

### ModelsProvider

```typescript
interface ModelsProvider {
  list(): Promise<ModelInfoEntry[]>;
}

interface ModelInfoEntry {
  id: string;        // e.g., 'claude-opus-4-7'
  name: string;      // e.g., 'Claude Opus'
  description?: string;
}
```

### StatusProvider

```typescript
interface StatusProvider {
  summary(): Promise<StatusSummary>;
}

interface StatusSummary {
  account?: string;           // e.g., 'user@example.com'
  model?: string;             // Current model
  permissionMode?: string;    // Current permission mode
}
```

### PermissionsProvider

```typescript
interface PermissionsProvider {
  modes(): Promise<PermissionModeInfo[]>;
}

interface PermissionModeInfo {
  id: string;          // e.g., 'default'
  name: string;        // e.g., 'Ask for every tool'
  description?: string;
}
```

### McpProvider

```typescript
interface McpProvider {
  servers(): Promise<McpServerInfo[]>;
}

interface McpServerInfo {
  name: string;        // e.g., 'filesystem'
  status: string;      // e.g., 'connected', 'disconnected'
}
```

---

## Approval Flow (Claude Code & CodeBuddy)

```
User sends message
        │
        ▼
onChat(ctx, message)
        │
        ├─→ Check for pending marker (disk)
        │
        ├─→ If marker found + user said "Allow"/"Deny":
        │   - Add to approval cache
        │   - Re-run query() with --resume
        │   - canUseTool hits cache → returns verdict immediately
        │   - Tool executes in this turn
        │
        └─→ If no marker (fresh message):
            - Run query()
            - SDK calls canUseTool() for tool_use blocks
            
            canUseTool(toolName, input)
                │
                ├─→ Check approval cache (already approved?)
                │   - YES: return 'allow' → tool executes
                │   - NO: continue
                │
                ├─→ Check pattern rules (allow all similar?)
                │   - YES: return 'allow' → tool executes
                │   - NO: continue
                │
                └─→ Async confirmation needed:
                    - Send ctx.sendActionConfirmation()
                    - Persist "pending marker" to disk
                    - Return 'deny' → ends this turn
                    - (User returns with verdict later)
```

---

## File Scanning (Slash Commands)

Each agent scans markdown files with YAML frontmatter:

```markdown
---
name: deploy
aliases: [d, roll]
description: Deploy to production
argument_hint: "[--dry-run]"
---

This command is handled by the LLM.
The frontmatter is parsed by `scanCommandsDir()`.
```

**Merge order (highest priority first):**
1. Filesystem scans (project scope, then user scope)
2. SDK registry handlers (typed handlers with descriptions)
3. SDK init message (bare command names from system/init)

**Example (Claude Code):**
```typescript
override async onCommandsList(params) {
  const registryResult = await super.onCommandsList(params);  // Step 2
  const scanned = await scanCommandsDir(...);                  // Step 1
  const sdk = this.sdkSlashCommands.map(...);                  // Step 3
  
  // Merge by name; filesystem wins
  const byName = new Map();
  for (const cmd of sdk) byName.set(cmd.name, cmd);
  for (const cmd of registryResult.commands) byName.set(cmd.name, cmd);
  for (const cmd of scanned) {
    if (!byName.has(cmd.name) || byName.get(cmd.name).source !== 'filesystem') {
      byName.set(cmd.name, cmd);
    }
  }
  return { commands: [...byName.values()] };
}
```

---

## Wire Protocol Example: Async Confirmation

**Agent → App (non-blocking):**
```json
{
  "jsonrpc": "2.0",
  "method": "ui.actionConfirmation",
  "params": {
    "task_id": "task_123",
    "confirmation_id": "confirm_456",
    "prompt": "Run npm build?",
    "actions": [
      { "label": "Allow", "value": "allow" },
      { "label": "Deny", "value": "deny" }
    ]
  }
}
```

Agent returns from `onChat()` immediately.

**User taps "Allow" → App sends new message:**
```json
{
  "jsonrpc": "2.0",
  "method": "agent.chat",
  "params": {
    "session_id": "sess_abc",
    "message": "Allow"
  }
}
```

**Agent's next onChat() call:**
- Classifies message as verdict "allow"
- Checks for pending marker (disk)
- Re-runs `query()` with `--resume`
- Tool executes

---

## Testing Utilities

### Mock Query Function

Replace the SDK's `query()` with a scripted implementation:

```typescript
// For Claude Code
const mockQuery: QueryFn = async function* (params) {
  yield {
    type: 'system',
    subtype: 'init',
    session_id: 'session_abc',
    slash_commands: ['help', 'logs'],
  };
  yield {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Hello!' },
      ],
    },
  };
  yield {
    type: 'result',
    subtype: 'end_turn',
  };
};

const agent = new ClaudeCodeAgent({
  queryFn: mockQuery,  // Inject mock instead of real SDK
});
```

---

