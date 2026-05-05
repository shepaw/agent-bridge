# Shepaw Agent Bridge — Implementation Guide

## Quick Reference: What Needs to Be Fixed

### 1. ✅ ALREADY WORKING — No Changes Needed

These features are fully functional across all agents (or designed to work as-is):

| Feature | Location | Status |
|---------|----------|--------|
| `/model` picker | All `registry.ts` files | ✅ Working |
| `/status` command | All `registry.ts` files (line 43/48/59/40) | ✅ Working |
| `/mcp` command | All `registry.ts` files (line 44/49/60/41) | ✅ Working |
| `/permissions` (Claude Code & CodeBuddy) | `claude-code-ts/registry.ts:51-61`, `codebuddy-code/registry.ts:62-72` | ✅ Working |
| Async tool approval (Claude Code & CodeBuddy) | `agent.ts:559-567` in both | ✅ Working |
| Slash command file scanning | All `agent.ts` files | ✅ Working |
| Message metadata (collapsible) | All `agent.ts` files | ✅ Working |

---

### 2. ⚠️ PARTIAL — Some Agents Need Updates

#### OpenCode Registry Missing `/permissions`

**File:** `/Users/edenzou/workspace/shepaw/agent-bridge/implementations/opencode-ts/src/commands/registry.ts`

**Current (lines 1-44):**
```typescript
export function buildRegistry(hooks: BuildRegistryHooks): SlashCommandRegistry<OpenCodeCfg> {
  const registry = new SlashCommandRegistry<OpenCodeCfg>();
  registry.register(
    createModelHandler<OpenCodeCfg>({
      applyModel: (cfg, key, models: ModelInfoEntry[]) => {
        const found = models.find((m) => m.id === key);
        if (!found) return undefined;
        cfg.model = key;
        hooks.onModelApplied(key);
        return found;
      },
    }),
  );
  registry.register(createStatusHandler<OpenCodeCfg>());
  registry.register(createMcpHandler<OpenCodeCfg>());
  return registry;
}
```

**What's missing:** No `/permissions` handler. But first check if OpenCode's SDK supports it.

**Action Items:**
1. Determine if OpenCode needs permission-mode switching
2. If yes: add `createPermissionsHandler` like Claude Code (lines 51-61 of `claude-code-ts/registry.ts`)
3. If no: add a comment explaining why (like Codex does)

---

#### Codex: Document Why No `/permissions`

**File:** `/Users/edenzou/workspace/shepaw/agent-bridge/implementations/codex-ts/src/commands/registry.ts`

**Current (lines 8-9):**
```typescript
/**
 * `/permissions` is intentionally omitted — Codex's approval policy is set at
 * startup via `approvalPolicy` and cannot be changed mid-session by the app.
 */
```

**Status:** ✅ Already documented. No changes needed.

---

### 3. ❌ CANNOT BE IMPLEMENTED — SDK Limitations

These features require changes to underlying SDKs or the Shepaw framework:

#### A. Claude Code: Thinking/Reasoning Streaming
- **Issue:** Claude Agent SDK (v0.2.114) does not expose thinking blocks
- **Impact:** User cannot see Claude's internal reasoning
- **Action:** File an issue with Anthropic requesting thinking block exposure

#### B. Codex: Async Tool Confirmation
- **Issue:** Codex SDK has no callback hooks for tool approval (only startup `approvalPolicy`)
- **Impact:** Codex users cannot approve tool calls from phone (must pre-authorize or deny all)
- **Action:** File an issue with OpenAI requesting `canUseTool` callback support

#### C. Both Codex and CodeBuddy: MCP Server Management
- **Issue:** SDKs provide no write/mutation APIs for MCP configuration
- **Impact:** Cannot dynamically add/remove/restart MCP servers at runtime
- **Action:** File feature requests with respective SDKs

#### D. All Agents: Todo List Updates Hook
- **Issue:** Shepaw SDK has no `onTodoUpdated` hook
- **Impact:** Cannot implement reactive task tracking
- **Action:** File an issue with Shepaw requesting todo change hooks

#### E. CodeBuddy: Permissions Provider
- **Issue:** Tencent SDK (`@tencent-ai/agent-sdk` v0.3.131) does not expose permission modes
- **Impact:** `/permissions` command will show "not supported"
- **Action:** File an issue with Tencent requesting permission-mode APIs

#### F. All Agents: Approval Cache Introspection
- **Issue:** SDK has no public API to query/manage cached approvals
- **Impact:** Users cannot see or revoke pre-approved tools
- **Action:** File an issue with Shepaw requesting cache inspection APIs

---

## Immediate Action Items

### 1. Verify OpenCode Permissions Support (15 min)

Check if OpenCode's underlying SDK supports permission modes:

```bash
# Find OpenCode implementation
find /Users/edenzou/workspace/shepaw/agent-bridge/implementations/opencode-ts -name "*.ts" -type f | xargs grep -l "permission"
# Look for a permissions-provider.ts file or similar
```

**If found:** Add `createPermissionsHandler` to registry.ts (copy from claude-code-ts)  
**If not found:** Document why (like Codex does)

---

### 2. Create SDK Feature Request Issues (30 min)

**For Anthropic (Claude Agent SDK team):**
- Subject: "Request: Expose thinking blocks in Agent SDK"
- Reference: `/implementations/claude-code-ts/src/agent.ts` lines 455-462 (reasoning item handling)

**For OpenAI (Codex SDK team):**
- Subject: "Request: Support async tool confirmation callback (canUseTool hook)"
- Reference: `/implementations/codex-ts/src/agent.ts` lines 18-22 (current limitation)

**For Tencent (CodeBuddy Agent SDK team):**
- Subject: "Request: Expose permission modes API (getPermissionModes)"
- Reference: `/implementations/codebuddy-code/src/commands/permissions-provider.ts`

**For Shepaw (ACP SDK team):**
- Subject: "Request: Expose todo list update hooks (onTodoUpdated)"
- Reference: `/implementations/*/src/agent.ts` (all agents need this)

---

### 3. Document Current State (20 min)

Update each agent's README or comments:

**Codex** (`implementations/codex-ts/README.md` or agent.ts header):
```
⚠️ Known Limitation: Async tool confirmation not supported.
- Codex SDK does not provide callback hooks for tool approval.
- Users must set `approvalPolicy: 'on-request'` (synchronous) at startup.
- Feature request filed: [link to issue]
```

**Claude Code** (`implementations/claude-code-ts/README.md`):
```
✅ Supports async tool confirmation.
❌ Thinking blocks not yet exposed by Claude Agent SDK.
- Feature request filed: [link to Anthropic issue]
```

---

## Testing Changes

After making any registry.ts changes:

```bash
# Rebuild the agent
cd implementations/codex-ts  # (or claude-code-ts, codebuddy-code, opencode-ts)
npm run build

# Run type check
npm run typecheck

# Test the slash command
# 1. Start the agent
node dist/cli.js

# 2. In another terminal, call via curl (if HTTP endpoint exists)
# or via the Shepaw app
```

---

## Rollout Priority

1. **High:** Verify and fix OpenCode `/permissions` (if applicable)
2. **Medium:** File SDK feature request issues
3. **Low:** Update documentation with known limitations

---

