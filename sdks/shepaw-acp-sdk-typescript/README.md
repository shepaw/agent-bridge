# shepaw-acp-sdk

TypeScript SDK for building [Shepaw](https://shepaw.com) ACP agents.
Wire-compatible with the Python [`shepaw_acp_sdk`](https://pypi.org/project/shepaw-acp-sdk/).

## Install

```sh
npm install shepaw-acp-sdk
```

## 20-line echo agent

```ts
import { ACPAgentServer, TaskContext } from 'shepaw-acp-sdk';

class EchoAgent extends ACPAgentServer {
  override async onChat(ctx: TaskContext, message: string) {
    await ctx.sendText(`Echo: ${message}`);
  }
}

await new EchoAgent({ name: 'Echo', token: 'my-secret' }).run({ port: 8080 });
```

Connect from Shepaw at `ws://<host>:8080/acp/ws` with token `my-secret`.

## What's in the box

| Class / function | Purpose |
|---|---|
| `ACPAgentServer` | Subclass and override `onChat`. Handles auth, heartbeat, chat dispatch, cancel, UI responses, rollback, agent-card, hub request tracking, conversation history. |
| `TaskContext` | Per-task helper. `sendText`, `sendTextFinal`, `sendActionConfirmation`, `sendSingleSelect`, `sendMultiSelect`, `sendFileUpload`, `sendForm`, `sendFileMessage`, `sendMessageMetadata`, `hubRequest`, `waitForResponse`. |
| `ConversationManager` | Per-session message history with auto-trimming and TTL cleanup. |
| `ACPDirectiveStreamParser` | Streaming parser for `<<<directive ... >>>` fence blocks in LLM output. |
| `acpDirectiveToNotification` | Convert a parsed directive to a `ui.*` notification. |
| `jsonrpcRequest` / `jsonrpcResponse` / `jsonrpcNotification` | JSON-RPC 2.0 builders. |

## Wire compatibility

This SDK reproduces the on-the-wire protocol of the Python `shepaw_acp_sdk`
**exactly** — same methods (`agent.chat`, `agent.cancelTask`, `agent.submitResponse`,
`agent.rollback`, `agent.getCard`, `agent.requestFileData`, `auth.authenticate`,
`ping`), same notifications (`task.started`, `task.completed`, `task.error`,
`ui.textContent`, `ui.actionConfirmation`, `ui.singleSelect`, `ui.multiSelect`,
`ui.fileUpload`, `ui.form`, `ui.fileMessage`, `ui.messageMetadata`), same
snake_case field names (`task_id`, `session_id`, `is_final`, `confirmation_id`,
`select_id`, `upload_id`, `form_id`, `min_select`, `max_select`, etc.).

A Shepaw app that talks to a Python agent can talk to a TypeScript agent
with zero changes.

## Not included in v0

- `Tunnel` / Channel Service — can be added if you need public internet
  reach. Single-machine LAN use doesn't need it.
- `OpenClawChannel` — not yet ported.
- LLM providers (`OpenAIProvider`, `ClaudeProvider`, `GLMProvider`) — use
  whichever SDK you prefer in your agent's `onChat`.

## License

Apache-2.0
