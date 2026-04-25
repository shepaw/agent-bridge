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

await new EchoAgent({ name: 'Echo' }).run({ port: 8080 });
```

Before the Shepaw app can connect, authorize its device public key
(copy from the "Add remote agent" screen):

```sh
shepaw-acp-peers add <base64-pubkey> --label "My iPhone"
# or use the programmatic API (`addPeer` from this SDK) in your own tool
```

Then paste the URL printed on the banner (including `#fp=...`) into
Shepaw.

## v2.1 protocol (end-to-end encrypted, public-key allowlist)

Every WebSocket frame between the Shepaw app and the agent is sealed
with ChaCha20-Poly1305 under keys derived from a Noise IK handshake
(`Noise_IK_25519_ChaChaPoly_BLAKE2b`, prologue `"shepaw-acp/2.1"`). The
Channel Service relay can no longer see message contents or method
names.

**Authorization is per-device.** There is no shared token. Each paired
Shepaw device has its own X25519 static keypair; the agent maintains
an `authorized_peers.json` allowlist of public keys and rejects any
handshake whose peer static pubkey is not on the list (WS close
`4405`).

On first start the agent generates a long-term X25519 keypair and
writes it to `~/.config/shepaw-cb-gateway/identity.json` (Unix `0600`;
override with `SHEPAW_IDENTITY_PATH`). The allowlist is in the same
directory: `authorized_peers.json` (override with `SHEPAW_PEERS_PATH`).
The startup banner prints:

```
Agent ID:         acp_agent_a1b2c3d4
Fingerprint:      a1b2c3d4ffd6fa20
Authorized peers: 2
ACP WS:           ws://.../acp/ws?agentId=acp_agent_a1b2c3d4#fp=a1b2c3d4ffd6fa20
```

Share the whole URL (including the `#fp=` fragment — it is
client-side only, never sent to the relay) with the Shepaw user, who
pastes it into the app. The app pins the fingerprint and rejects any
handshake whose `SHA-256(responder_static_pubkey)[0..8]` does not
match. A detailed threat model, including the revocation flow, is in
[`SECURITY.md`](../../SECURITY.md).

### Programmatic peer management

The SDK exports pure functions for managing the allowlist so tools
and alternative CLIs can reuse them:

```ts
import {
  resolvePeersPath,
  loadOrCreatePeers,
  addPeer,
  removePeerByFingerprint,
  isPeerAuthorized,
} from 'shepaw-acp-sdk';

const path = resolvePeersPath();
const peers = loadOrCreatePeers({ path });
addPeer(path, '<base64-pubkey>', 'Alice iPhone');  // idempotent
removePeerByFingerprint(path, 'a1b2c3d4e5f6a7b8');  // true/false
```

`addPeer` and `removePeerByFingerprint` use atomic rename writes. A
running agent with `fs.watch` enabled picks up the change within
~100 ms and boots any now-unauthorized connected sessions with WS
`4411`.

### Bootstrap pairing via one-time codes

For the "first pair" flow — when the app's pubkey is not yet in
`authorized_peers.json` — the SDK provides a single-use pairing token
mechanism. The agent operator mints a code, the app presents it in
the Noise msg 1 payload, the agent auto-promotes the device into the
allowlist on success. Codes are 9 chars from a 31-char alphabet
(~44 bits entropy), have a 10-minute default TTL, and travel
encrypted inside Noise.

```ts
import {
  resolveEnrollmentsPath,
  createEnrollmentToken,
  consumeEnrollmentToken,
  revokeEnrollmentToken,
  formatCodeForDisplay,
} from 'shepaw-acp-sdk';

const path = resolveEnrollmentsPath();
const t = createEnrollmentToken(path, { label: 'Alice iPhone' });
console.log(`Pairing code: ${formatCodeForDisplay(t.code)}`);
```

The gateway CLIs expose `enroll`, `enroll-list`, `enroll-revoke`
subcommands. `ACPAgentServer` automatically consumes tokens presented
in Noise msg 1 payloads — no extra server wiring required.

**Upgrading from v2:** there is no backward-compatibility shim — v2.1
changes the Noise prologue, so v2 clients' handshakes no longer
validate. Both the agent SDK and the Shepaw app must be updated in
the same release window. Old `--token` flags are removed from
gateway CLIs; use `peers add` on the agent host instead.

## What's in the box

| Class / function | Purpose |
|---|---|
| `ACPAgentServer` | Subclass and override `onChat`. Handles auth, heartbeat, chat dispatch, cancel, UI responses, rollback, agent-card, hub request tracking, conversation history. |
| `TaskContext` | Per-task helper. `sendText`, `sendTextFinal`, `sendActionConfirmation`, `sendForm`, `sendFileUpload`, `sendFileMessage`, `sendMessageMetadata`, `hubRequest`. `sendSingleSelect` / `sendMultiSelect` / `waitForResponse` still work but are deprecated — prefer the non-blocking pattern below. |
| `ConversationManager` | Per-session message history with auto-trimming and TTL cleanup. |
| `ACPDirectiveStreamParser` | Streaming parser for `<<<directive ... >>>` fence blocks in LLM output. |
| `acpDirectiveToNotification` | Convert a parsed directive to a `ui.*` notification. |
| `jsonrpcRequest` / `jsonrpcResponse` / `jsonrpcNotification` | JSON-RPC 2.0 builders. |
| `resolvePeersPath` / `loadOrCreatePeers` / `addPeer` / `removePeerByFingerprint` / `isPeerAuthorized` | Authorized-peer allowlist management (see above). |
| `resolveEnrollmentsPath` / `createEnrollmentToken` / `consumeEnrollmentToken` / `revokeEnrollmentToken` / `formatCodeForDisplay` | Single-use pairing codes for bootstrap (see above). |

## Non-blocking UI pattern (recommended)

`waitForResponse` works — but it blocks the current `onChat` task until
the user interacts. On a phone the user may take minutes or hours to
respond, which ties up the WebSocket and looks frozen to them. The
preferred pattern is **fire-and-forget**:

```ts
override async onChat(ctx, message) {
  if (classify(message) === 'approval') {
    // Treat this message as a response to an earlier UI component.
    handleApproval(message);
    return;
  }
  if (needsClarification(message)) {
    // Send a form and return — no waitForResponse. The user's submission
    // arrives as a new `agent.chat` message on the next turn.
    await ctx.sendForm({
      title: 'Which language?',
      fields: [{
        name: 'lang',
        label: 'Language',
        type: 'radio_group',        // new field types in v0.1
        required: true,
        options: [
          { label: 'TypeScript', value: 'ts' },
          { label: 'Python', value: 'py' },
        ],
      }],
    });
    return;
  }
  // normal work here…
}
```

`radio_group` and `checkbox_group` fields are rendered in the Shepaw app
as native radio / checkbox groups with per-option descriptions. The
older `sendSingleSelect` / `sendMultiSelect` helpers still exist and
transparently emit a single-field form, so pre-v0.1 code keeps working.

## Wire compatibility

This SDK reproduces the on-the-wire protocol of the Python `shepaw_acp_sdk`
**at v1 level** — same methods, notifications, and snake_case field names.
The Python SDK is still v1 (plaintext) and will not interoperate with
v2.1 agents or Shepaw apps until ported to Noise IK + allowlist
authorization. Until then, use TypeScript on both sides.

## Not included in v0

- `Tunnel` / Channel Service — can be added if you need public internet
  reach. Single-machine LAN use doesn't need it.
- `OpenClawChannel` — not yet ported.
- LLM providers (`OpenAIProvider`, `ClaudeProvider`, `GLMProvider`) — use
  whichever SDK you prefer in your agent's `onChat`.

## License

Apache-2.0
