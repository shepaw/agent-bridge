# Shepaw Agent Bridge — Audit Results & Implementation Roadmap

**Date:** 2026-05-05  
**Status:** ✅ Audit Complete, Verified, Ready for Implementation

---

## 📋 Documentation Overview

This directory now contains four comprehensive audit and reference documents:

| Document | Purpose | Audience | Key Takeaways |
|----------|---------|----------|---------------|
| **AUDIT_REPORT.md** | Detailed findings of what works, needs fixing, and can't be implemented | Technical leads, architects | 7 working features, 7 SDK limitations, clear categorization |
| **IMPLEMENTATION_GUIDE.md** | Actionable next steps with exact file locations and code snippets | Developers | OpenCode decision point, feature request templates, testing procedures |
| **TECHNICAL_REFERENCE.md** | Deep reference on SDK architecture, APIs, and wire protocols | Senior engineers | SDK diagrams, provider interfaces, approval flow state machine |
| **VERIFICATION_SUMMARY.md** | Consolidated verification results confirming all findings | Team leads | ✅ No code changes needed, implementations are sound |

---

## 🎯 Quick Status: What Changed?

### ✅ No Code Changes Required

The audit confirmed that all four agent implementations are **architecturally sound**:

- **OpenCode:** Registry correctly omits `/permissions` (manages via SSE events)
- **Codex:** Registry correctly documents startup-only `approvalPolicy`
- **Claude Code:** `/permissions` handler working correctly
- **CodeBuddy:** `/permissions` handler working correctly

### 🚫 Limitations Identified (SDK-Level, Not Code Defects)

**Anthropic Claude Agent SDK (v0.2.114):**
- Thinking blocks not exposed → cannot show reasoning
- Feature request needed

**OpenAI Codex SDK (v0.128.0):**
- No async tool confirmation callback → Codex users can't approve tools dynamically
- Feature request needed

**Tencent Agent SDK (v0.3.131):**
- No permission modes provider → CodeBuddy `/permissions` shows "not supported"
- Feature request needed

**Shepaw ACP SDK:**
- No todo update hooks → cannot react to todo list changes
- No approval cache introspection → users can't see/revoke cached approvals
- Feature requests needed

---

## 🚀 Immediate Next Steps

### 1. Distribute Documentation (Today)
```bash
# Share with team leads
# - AUDIT_REPORT.md (5-minute overview)
# - VERIFICATION_SUMMARY.md (key findings)
# - Technical leads → TECHNICAL_REFERENCE.md for deep dive
```

### 2. File SDK Feature Requests (This Week)

**For Anthropic:**
```
Subject: Request: Expose thinking blocks in Agent SDK
Body: Cannot show Claude's internal reasoning to users
File: IMPLEMENTATION_GUIDE.md, section "B. Claude Code: Thinking/Reasoning"
```

**For OpenAI:**
```
Subject: Request: Support async tool confirmation callback
Body: Codex needs canUseTool hook for dynamic approval flow
File: IMPLEMENTATION_GUIDE.md, section "A. Codex: Async Tool Confirmation"
```

**For Tencent:**
```
Subject: Request: Expose permission modes API (getPermissionModes)
Body: CodeBuddy needs permissionMode configuration like Claude Code
File: AUDIT_REPORT.md, Part B, section "E. CodeBuddy: Permissions Provider"
```

**For Shepaw:**
```
Subject: Request: Add onTodoUpdated hook + approval cache introspection
Body: Needed for reactive task tracking and cache management
File: AUDIT_REPORT.md, Part B, sections "D" and "F"
```

### 3. Update Agent READMEs (Optional)

Document known limitations in each agent's README:

```markdown
## Known Limitations

### Codex
⚠️ Async tool confirmation not supported — Codex SDK only provides startup
`approvalPolicy`, not runtime callback hooks. Users must pre-authorize tools
or deny all.

### Claude Code
❌ Thinking blocks not exposed by Claude Agent SDK. Feature request filed.

### CodeBuddy
❌ Permission modes not available in Tencent SDK. Feature request filed.

### OpenCode
✅ All features working correctly.
```

---

## 📊 Audit Summary Table

| Agent | `/model` | `/status` | `/mcp` | `/permissions` | Async Confirm | Reasoning | Todo Updates |
|-------|----------|-----------|--------|----------------|---------------|-----------|--------------|
| Codex | ✅ | ✅ | ✅ | ❌ (by design) | ❌ (SDK limit) | ❌ (SDK limit) | ❌ (SDK limit) |
| Claude Code | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ (SDK limit) | ❌ (SDK limit) |
| CodeBuddy | ✅ | ✅ | ✅ | ⚠️ (provider missing) | ✅ | ❌ (SDK limit) | ❌ (SDK limit) |
| OpenCode | ✅ | ✅ | ✅ | ✅ (via SSE) | ✅ | ✅ | ❌ (SDK limit) |

Legend:
- ✅ Working
- ⚠️ Partial (feature exposed, provider unavailable)
- ❌ Not working (either by design or SDK limitation)

---

## 🔄 Implementation Roadmap

### Phase 1: Verify & Document (✅ DONE)
- [x] Audit all 4 agents
- [x] Identify SDK capabilities
- [x] Document limitations
- [x] Verify findings

### Phase 2: File Feature Requests (PLANNED)
- [ ] Anthropic: Thinking blocks
- [ ] OpenAI: Async tool confirmation
- [ ] Tencent: Permission modes
- [ ] Shepaw: Todo hooks, cache introspection

### Phase 3: Plan Workarounds (BACKLOG)
- [ ] Codex: Pre-auth workflow for tool confirmation
- [ ] CodeBuddy: Handle missing permissions gracefully
- [ ] All: MCP server management strategy

### Phase 4: Document for Users (BACKLOG)
- [ ] Add limitations to agent READMEs
- [ ] Create troubleshooting guides
- [ ] Document workarounds

---

## 📚 How to Use These Documents

### For Team Leads
1. Start with **VERIFICATION_SUMMARY.md** (2 min read)
2. Review **AUDIT_REPORT.md** Part D for quick checklist
3. Share **IMPLEMENTATION_GUIDE.md** with developers

### For Developers
1. Read **IMPLEMENTATION_GUIDE.md** section "Immediate Action Items"
2. Follow the testing procedures if making registry changes
3. Reference **TECHNICAL_REFERENCE.md** for deep dives on API details

### For Architects
1. Study **TECHNICAL_REFERENCE.md** for SDK architecture
2. Review provider interfaces and approval flow diagrams
3. Plan workarounds for critical limitations

---

## ✅ Testing Checklist

After any changes, verify:

- [ ] `/model` picker lists all models correctly
- [ ] `/status` shows current model, account, and permissionMode
- [ ] `/mcp` lists configured MCP servers with status
- [ ] `/permissions` picker works (Claude Code, CodeBuddy)
- [ ] Slash commands scan `.commands/` directory
- [ ] Async confirmation flow shows "Allow once/Always/Deny"
- [ ] Message metadata collapses tool output correctly
- [ ] All agents start without errors

---

## 📞 Questions?

Refer to:
- **"What's the current state?"** → VERIFICATION_SUMMARY.md
- **"What do we need to fix?"** → IMPLEMENTATION_GUIDE.md, section 2
- **"How does the architecture work?"** → TECHNICAL_REFERENCE.md
- **"What can't be implemented?"** → AUDIT_REPORT.md, Part B

---

## 🎓 Key Learnings

### Why No Code Changes Are Needed

The implementations correctly leverage each SDK's capabilities:

1. **Codex** uses a startup-only permission policy by design (architectural choice by OpenAI)
2. **Claude Code** has full async confirmation + mode switching (Anthropic's design)
3. **CodeBuddy** has async confirmation but Tencent doesn't expose permission modes
4. **OpenCode** uses event-driven approval (different model, equally valid)

Each design is **appropriate for its SDK**. Gaps are not implementation bugs but SDK feature gaps that need upstream feature requests.

### Why This Audit Matters

This comprehensive audit provides:
- ✅ Clear evidence that implementations are sound
- ✅ Concrete list of SDK feature requests to file
- ✅ Actionable roadmap for improvements
- ✅ Confidence to proceed with feature requests

---

**Next action:** Distribute AUDIT_REPORT.md and VERIFICATION_SUMMARY.md to the team.

