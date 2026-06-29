# Archived SDK gateways

These directories contain legacy Shepaw gateways that wrapped vendor SDKs directly
(Anthropic Claude Agent SDK, CodeBuddy SDK, Codex SDK, OpenCode SDK).

**New deployments should use [`acp-proxy-ts`](../acp-proxy-ts)** with the appropriate
`--engine` flag. Agent Hub spawns `shepaw-acp-proxy` for all engine types.

| Legacy gateway | ACP proxy equivalent |
|----------------|---------------------|
| `claude-code-ts` | `--engine claude-code` |
| `codebuddy-code` | `--engine codebuddy` |
| `codex-ts` | `--engine codex` |
| `opencode-ts` | `--engine opencode` |

The legacy packages are kept in the repository for reference but are no longer
part of the npm workspace build.
