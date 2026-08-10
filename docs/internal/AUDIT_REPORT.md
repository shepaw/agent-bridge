# Shepaw Agent Bridge — Comprehensive Audit Report

**Date:** 2026-05-05  
**SDK Versions:**
- `@anthropic-ai/claude-agent-sdk`: 0.2.114
- `@tencent-ai/agent-sdk`: 0.3.131
- `@openai/codex-sdk`: 0.128.0
- `shepaw-acp-sdk-typescript`: (local workspace)

---

## PART A: WHAT CAN BE IMPLEMENTED NOW

### 1. `/status` and `/mcp` Command Support

All four agents already have working implementations. **No changes needed.**

**Status:** ✅ Already registered
- **Codex** (`implementations/codex-ts/src/commands/registry.ts`, lines 43-44)
- **Claude Code** (`implementations/claude-code-ts/src/commands/registry.ts`, lines 48-49)
- **CodeBuddy** (`implementations/codebuddy-code/src/commands/registry.ts`, lines 59-60)
- **OpenCode** (`implementations/opencode-ts/src/commands/registry.ts`, lines 40-41)

**How they work:**
```typescript
registry.register(createStatusHandler<CodexCfg>());
registry.register(createMcpHandler<CodexCfg>());
```

The handlers are defined in `sdks/shepaw-acp-sdk-typescript/src/slash/handlers/`:
- `status.ts`: Pulls account info, model, permission mode, and MCP servers
- `mcp.ts`: Lists MCP servers and their status
- Both gracefully degrade if providers are missing

---

### 2. `/permissions` (Permission Mode Picker) for Claude Code & CodeBuddy

**Status:** ✅ Already registered in BOTH agents
- **Claude Code** (`implementations/claude-code-ts/src/commands/registry.ts`, lines 51-61)
- **CodeBuddy** (`implementations/codebuddy-code/src/commands/registry.ts`, lines 62-72)

Both agents:
1. Create a `PermissionsProvider` (status provider)
2. Register the handler with `createPermissionsHandler`
3. Call `onPermissionModeApplied(id)` hook when user selects a mode

**Example flow (Claude Code):**
```typescript
// agents/claude-code-ts/src/commands/registry.ts, lines 51-61
registry.register(
  createPermissionsHandler<ClaudeCfg>({
    applyMode: (cfg, id, modes: PermissionModeInfo[]) => {
      const found = modes.find((m) => m.id === id);
      if (!found) return undefined;
      cfg.permissionMode = id;
      hooks.onPermissionModeApplied(id);  // ← Hook called here
      return found;
    },
  }),
);
```

**Codex does NOT support `/permissions`** by design — its approval policy is set at startup and cannot be changed mid-session (line 8-9 of `codex-ts/registry.ts`).

---

### 3. Async Confirmation Flow (Tool Approval)

**Status:** ✅ Already fully implemented for Claude Code & CodeBuddy

**How it works:**
1. User sends message → `onChat(ctx)`
2. SDK calls `canUseTool` callback (via `makeCanUseTool` helper)
3. If approval is needed:
   - Send `ctx.sendActionConfirmation()` → prompts user (async, non-blocking)
   - Return `'deny'` immediately to end this turn
   - Persist pending marker to disk
4. User returns → new `agent.chat` message arrives
5. Check for pending marker → retrieve cached verdict → re-run query with `--resume`
6. On resume, `canUseTool` hits cache → returns verdict immediately
7. Tool executes in this resume turn

**Implementations:**

**Claude Code** (`implementations/claude-code-ts/src/agent.ts`, lines 559-567):
```typescript
canUseTool: makeCanUseTool(ctx, {
  sessionId: ctx.sessionId,
  cache: this.approvalCache,
  pending: this.pendingConfirmations,
  pendingMarker: this.pendingMarkerStore,
  patternRules: this.patternRuleStore,
  formAnswers: this.formAnswers,
  agentDisplayName: AGENT_DISPLAY_NAME,
}),
```

**CodeBuddy** (`implementations/codebuddy-code/src/agent.ts`, lines 471-479):
```typescript
canUseTool: makeCanUseTool(ctx, {
  sessionId: ctx.sessionId,
  cache: this.approvalCache,
  pending: this.pendingConfirmations,
  pendingMarker: this.pendingMarkerStore,
  patternRules: this.patternRuleStore,
  formAnswers: this.formAnswers,
  agentDisplayName: AGENT_DISPLAY_NAME,
}),
```

**Codex does NOT implement this** — it only has synchronous approval via `approvalPolicy` at startup.

---

### 4. Slash Command File Scanning

**Status:** ✅ Already implemented for all agents

All agents scan `./<vendor>/commands/*.md` files and merge them with SDK registry commands:

**Claude Code** (`implementations/claude-code-ts/src/agent.ts`, lines 663-691):
```typescript
override async onCommandsList(params: CommandsListParams): Promise<CommandsListResult> {
  const registryResult = await super.onCommandsList(params);
  const registryCmds = registryResult.commands;

  const scannedGroups = await Promise.all(
    this.commandsDirs.map((d) => scanCommandsDir(d.path, d.scope)),
  );
  const scanned = scannedGroups.flat();

  // Merge: filesystem > registry > SDK init
  const byName = new Map<string, SlashCommandInfo>();
  // ... dedup logic ...
  return { commands: [...byName.values()] };
}
```

**Codex**, **CodeBuddy**, and **Claude Code** all follow the same pattern.

---

### 5. Form Submission and Async Response Handling

**Status:** ✅ Already in the SDK, partially used

Available in SDK (`shepaw-acp-sdk-typescript/src/task-context.ts`):
```typescript
async sendForm(opts: SendFormOpts): Promise<string> {
  // Returns formId; user response arrives later as a new agent.chat
}

async sendActionConfirmation(opts: SendActionConfirmationOpts): Promise<string> {
  // Non-blocking; user response is a new agent.chat message
}
```

Both **Claude Code** and **CodeBuddy** use these for:
- Form submissions (users type `Form submitted: …`)
- Approval verdicts (users type `Allow`/`Deny`)

**What's NOT used yet:**
- `sendSingleSelect()` (deprecated, use `sendForm` with `radio_group`)
- `sendMultiSelect()` (deprecated, use `sendForm` with `checkbox_group`)
- `sendFileUpload()`
- `sendFileMessage()`

---

### 6. Model Picker (`/model`)

**Status:** ✅ Already fully implemented

All agents register `/model` via `createModelHandler`:

**Claude Code** (`implementations/claude-code-ts/src/commands/registry.ts`, lines 36-45):
```typescript
registry.register(
  createModelHandler<ClaudeCfg>({
    applyModel: (cfg, id, models: ModelInfoEntry[]) => {
      const found = models.find((m) => m.id === id);
      if (!found) return undefined;
      cfg.model = id;
      hooks.onModelApplied(id);
      return found;
    },
  }),
);
```

Each agent has a `ModelsProvider` that fetches available models from the underlying SDK.

---

### 7. Message Metadata (Collapsible Blocks)

**Status:** ✅ Already implemented

All agents use `ctx.sendMessageMetadata()` for command output and file changes:

**Codex** (`implementations/codex-ts/src/agent.ts`, lines 403-408):
```typescript
if (item.type === 'command_execution') {
  await ctx.sendMessageMetadata({
    collapsible: true,
    collapsibleTitle: `$ ${item.command}`,
    autoCollapse: true,
  });
}
```

Same pattern in Claude Code and CodeBuddy.

---

## PART B: WHAT CANNOT BE IMPLEMENTED

### 1. ❌ Reasoning/Thinking Content Streaming (Claude Code)

**What we need:** Stream Claude's internal reasoning/thinking blocks to users (e.g., `<thinking>…</thinking>`).

**What the SDK provides:** None. The Claude Agent SDK (v0.2.114) does **not** expose thinking content.

**Evidence:**
- Checked `@anthropic-ai/claude-agent-sdk` type definitions — no `ContentBlockThinking` type
- SDK only supports: `assistant` messages with `text` and `tool_use` blocks
- No hook for intercepting thinking/internal reasoning

**Workaround:**
- None available. This requires Claude API changes or SDK updates.
- File an issue with Anthropic to expose thinking blocks in the Agent SDK.

**Impact:** Claude Code's reasoning (if available in the underlying Claude model) is currently invisible to users.

---

### 2. ❌ Async Tool Confirmation for Codex

**What we need:** Non-blocking approval flow (deny-and-resume) like Claude Code.

**What Codex provides:** Only synchronous approval via startup `approvalPolicy`:
- `never` → run all tools without asking
- `on-request` → ask for approval **synchronously during the turn**
- `on-failure` → retry on sandbox failure
- `untrusted` → always ask (same as `on-request`)

**Why it can't be implemented:**
1. Codex SDK does NOT expose an `approvalCallback` or `canUseTool` hook
2. The Codex CLI process runs internally; we have no way to inject custom approval logic
3. Approval decisions are **baked into the Codex thread** at startup; they cannot be changed or staged for later

**Evidence:**
- `implementations/codex-ts/src/agent.ts` lines 320-325: We only pass `approvalPolicy` to `ThreadOptions`
- No callback hooks in the Codex SDK for tool approval
- The comment at line 18-22 explicitly documents this limitation

**Workaround:**
- Users can set `approvalPolicy: 'on-request'` which asks at runtime (synchronously)
- Or set `approvalPolicy: 'never'` for full autonomy
- But these are binary, not confirmable via the Shepaw app

**Impact:** Codex users cannot approve tool calls from their phone; they must either pre-authorize or deny all.

---

### 3. ❌ Todo List Updates (`onTodoUpdated` Hook)

**What we need:** A hook that fires when task list is updated, so agents can respond dynamically.

**What the SDK provides:** None.

**Evidence:**
- No `onTodoUpdated`, `onTaskUpdated`, or similar in `ACPAgentServer`
- No `sendTodoUpdated` or `todoList` notification type in `TaskContext`
- The SDK has no awareness of "todo" vs "task" semantics
- Only `task.started`, `task.completed`, `task.error` lifecycle notifications

**Workaround:**
- Agents cannot know when users have marked tasks complete outside the chat flow
- Users must tell the agent explicitly (e.g., "I marked task X as done")
- File an issue with Shepaw to expose todo list changes as hooks

**Impact:** No way to implement reactive task tracking or auto-completion confirmations.

---

### 4. ❌ MCP Server Management via SDK

**What we need:** Ability to query/change MCP server configurations from code.

**What the SDK provides:** Read-only via `/mcp` handler (lists servers only).

**Evidence:**
- `createMcpHandler` (status.ts, line 17-40) only calls `deps.providers.mcp?.servers()`
- No write/mutation method for adding/removing/restarting MCP servers
- Each underlying SDK manages MCP differently:
  - Claude Agent SDK: Only via `system/init` message (read-only in the handler)
  - CodeBuddy Agent SDK: Tencent's SDK doesn't expose MCP config APIs
  - Codex SDK: Not surfaced at all

**Workaround:**
- None. MCP server management must happen outside the agent.
- Users configure `.claude/mcp.json` or equivalent manually.

**Impact:** Agents cannot dynamically enable/disable MCP tools at runtime.

---

### 5. ❌ Approval Cache Introspection

**What we need:** Query what tool approvals are currently cached, or expire them manually.

**What the SDK provides:** Internal `ApprovalCache` class (not public).

**Evidence:**
- `ApprovalCache` is used internally by both Claude Code and CodeBuddy agents
- No getter to retrieve cache contents
- No method to clear or expire entries
- Cache TTL is hardcoded (internal to the class)

**Workaround:**
- Agents can access their own `approvalCache` instance and call internal methods (not recommended)
- No public API

**Impact:** Users cannot see which tools they've pre-approved, or revoke approvals.

---

### 6. ❌ Pattern Rule Store Introspection

**What we need:** Query "Allow All Similar" pattern rules that have been saved.

**What the SDK provides:** Internal `PatternRuleStore` class (not public).

**Evidence:**
- `PatternRuleStore` is used internally for persistent approval rules
- No getter to retrieve rules
- No method to delete rules
- No public API exposed

**Workaround:**
- Read the JSON files directly from `~/.config/shepaw-*/session-rules.json` and `global-rules.json` (fragile)
- File an issue with Shepaw to expose this as a public API

**Impact:** Users cannot review or manage their approval rules.

---

### 7. ❌ CodeBuddy Permissions Provider (Partial Support)

**What we found:** CodeBuddy has a `permissionsProvider` but the underlying Tencent SDK does NOT expose permission modes.

**Evidence:**
- `implementations/codebuddy-code/src/commands/permissions-provider.ts` likely calls Tencent SDK
- Tencent SDK (`@tencent-ai/agent-sdk` v0.3.131) has NO public `getPermissionModes()` or similar
- The `/permissions` handler will show "not supported" on CodeBuddy

**Workaround:**
- CodeBuddy cannot currently switch permission modes via `/permissions`
- Set it at startup via the agent options

**Impact:** CodeBuddy users cannot dynamically change approval behavior.

---

## PART C: SDK Capabilities Summary

### TaskContext Methods Available

**Streaming:**
- `sendText(content)` — stream text incrementally
- `sendTextFinal()` — mark text as final

**Interactive Components (async, non-blocking):**
- `sendActionConfirmation()` — prompt: Do you want to approve?
- `sendForm()` — render form with fields (text, radio_group, checkbox_group, etc.)
- `sendSingleSelect()` — ⚠️ deprecated, use `sendForm` with `radio_group`
- `sendMultiSelect()` — ⚠️ deprecated, use `sendForm` with `checkbox_group`
- `sendFileUpload()` — prompt for file upload
- `sendFileMessage()` — send a file/media message

**Metadata:**
- `sendMessageMetadata()` — add collapsible headers, auto-collapse toggles

**Lifecycle:**
- `started()` — mark task as started
- `completed()` — mark task as successfully completed
- `error(message, code)` — mark task as failed

**Hub Requests (Agent → App):**
- `hubRequest<T>(method, params, opts)` — send JSON-RPC request to app, wait for response

---

### SlashCommandRegistry

**Handlers exported by SDK:**
- `createModelHandler()` — `/model list|<id>`
- `createStatusHandler()` — `/status`
- `createMcpHandler()` — `/mcp`
- `createPermissionsHandler()` — `/permissions list|<id>`

**How to extend:**
1. Create a custom handler implementing `SlashCommandHandler<C>`
2. Call `registry.register(handler)` in `buildRegistry()`
3. Handler's `handle()` method receives `TaskContext`, args, and can call `ctx.sendText()`, `ctx.sendForm()`, etc.
4. Return `true` to skip `onChat`; return `false` to fall through to LLM

---

## PART D: Quick Implementation Checklist

| Feature | Codex | Claude Code | CodeBuddy | OpenCode | Status |
|---------|-------|-------------|-----------|----------|--------|
| `/model` | ✅ | ✅ | ✅ | ✅ | Ready |
| `/status` | ✅ | ✅ | ✅ | ✅ | Ready |
| `/mcp` | ✅ | ✅ | ✅ | ✅ | Ready |
| `/permissions` | ❌* | ✅ | ✅ | ❌** | Ready (2/4) |
| Async tool approval | ❌ | ✅ | ✅ | ❌ | Partial |
| Reasoning streaming | N/A | ❌ | N/A | N/A | Blocked by SDK |
| Todo hooks | ❌ | ❌ | ❌ | ❌ | Blocked by SDK |

*Codex: `approvalPolicy` is startup-only, no runtime toggle  
**OpenCode: Not implemented in registry yet

---

