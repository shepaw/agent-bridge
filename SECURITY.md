# Security — Shepaw ACP v2.1

This document describes the security model of the ACP v2.1 wire protocol
(Noise IK over WebSocket with a per-device public-key allowlist), what it
**does** protect against, and what it **deliberately does not**.

## TL;DR

Every byte between the Shepaw app and your agent is sealed with
`ChaCha20-Poly1305` under a per-session key derived from a Noise `IK`
handshake (`Noise_IK_25519_ChaChaPoly_BLAKE2b`). The Channel Service
(the public relay at `channel.shepaw.com`) sees only handshake bytes
and opaque ciphertext. It cannot read your messages or the agent's
responses.

**v2.1 removes the shared `token` entirely.** Access to an agent is
authorized by listing the app's X25519 static public key in
`authorized_peers.json` on the agent host. Each paired device is its
own line in the allowlist, so a lost phone is revoked by a single
`peers remove` call instead of forcing every other device to re-pair.

The agent authenticates itself to the app through a **16-hex fingerprint**
(`SHA-256(agent_static_pubkey)[0..8]`) pasted into the app as part of
the URL (`...#fp=abcdef0123456789`). The app authenticates itself to
the agent with its own X25519 static key, generated on first launch.
If the app's public key is not in `authorized_peers.json`, the agent
closes the WebSocket with code `4405` *after* the Noise handshake
completes — no data frames are ever exchanged.

## Threat model

### Protected against

- **Passive wiretap** on the path between app and agent — including
  anyone who runs the Channel Service. Sees only `{v:2, t:"data",
  p:"<base64 AEAD ciphertext>"}` frames. No plaintext, no JSON-RPC
  method names, no shared secrets. Verified by the
  `test/relay-sniff.test.ts` integration test: a malicious Channel
  Service operator dumping every relayed byte finds zero hits on chat
  text, method names, or revocation RPC names.

- **Active MITM at the relay**. Even if the Channel Service operator
  swaps in their own agent public key, the app checks
  `SHA-256(pubkey)[0..8]` against the pinned `#fp=` in the URL; a
  mismatch closes the session with WS code `4403` before any data
  frame is exchanged.

- **Session replay / out-of-order delivery**. Noise counters are
  enforced monotonically per direction; a replayed or reordered frame
  fails the AEAD check and closes the session with `4409`.

- **agentId forgery**. The agent persists its identity on disk. The
  app pastes the expected `agentId` (derived from the pubkey) into
  the URL; a claim-vs-identity mismatch at handshake closes with
  `4404`.

- **Protocol downgrade**. The Noise prologue is `"shepaw-acp/2.1"`,
  binding the version into the handshake transcript. A v2 client (old
  prologue) or v1 client (plaintext frames) cannot complete the
  handshake against a v2.1 agent. This is a **hard cutover** — both
  sides must be on v2.1.

- **Forward secrecy**. Each WebSocket reconnect is a fresh Noise
  session with fresh ephemerals; compromising one session's keys does
  not unlock past traffic.

- **Unauthorized peers** (new in v2.1). The agent rejects any
  connection whose `peerStaticPublicKey` is not in
  `authorized_peers.json`, even if the Noise handshake itself
  succeeds. Operators maintain the list with
  `<gateway> peers {list,add,remove}`.

- **Shared-token compromise** (new in v2.1). No token exists. Previous
  versions leaked the `token=` query parameter in plaintext on non-TLS
  hops; there is nothing equivalent to leak now. A captured URL can
  only reach the Channel Service routing layer — without the app's
  private key, an attacker cannot complete the Noise handshake, and
  without an entry in `authorized_peers.json`, they cannot exchange
  data frames even if they steal a phone's key.

- **Live revocation** (new in v2.1). `peers remove <fp>` atomically
  rewrites `authorized_peers.json`; the agent's `fs.watch` observer
  picks up the change within ~100 ms and forcibly closes any active
  WebSocket session belonging to that fingerprint with code `4411`.
  The app surfaces this as "this device was revoked" rather than a
  generic network error.

- **App-initiated revocation** (new in v2.1). When a user deletes an
  agent from the Shepaw app, the app sends `peer.unregister` over the
  existing Noise session before tearing down. The agent removes its
  own row from `authorized_peers.json`, so the operator doesn't end
  up with a stale allowlist entry the user never meant to keep.

- **Bootstrap-code compromise** (v2.1 `enroll` flow). Pairing codes
  are 9 characters from a 31-char alphabet (~44 bits entropy),
  10-minute TTL, single-use, and **transmitted inside the
  Noise-encrypted msg 1 payload** — a passive observer on the Channel
  Service sees only AEAD ciphertext. Brute-forcing a specific 10-minute
  window at 1000 guesses/sec takes ~140 years on average, and every
  guess costs a full Noise handshake with the agent. Codes never travel
  out-of-band in the clear unless the operator pastes them into an
  insecure chat — choose the transport accordingly.

### Not protected against (explicit non-goals in v2.1)

- **Compromised agent host.** Anyone who can read `identity.json`
  from the agent's config directory can impersonate the agent to
  every paired app. Reading `authorized_peers.json` additionally
  leaks the set of device public keys, but *not* their private keys
  — impersonating a paired app still requires stealing that phone's
  secure-storage key.

- **Compromised phone.** Anyone with access to the phone's secure
  storage can read the app's long-term X25519 private key and
  impersonate that specific phone to paired agents. Mitigation: on
  the agent host, `peers remove <fp>` immediately evicts the lost
  device. Other devices are unaffected.

- **Metadata at the relay.** Channel Service still sees connection
  timing, frame sizes, source/destination IP, and the routing slug.
  Padding is not implemented.

- **Traffic analysis.** Frame sizes leak the shape of the traffic.

- **Server-side fingerprint rotation push.** If the agent rotates its
  identity, paired apps will start failing `4403` and must be
  re-paired manually. No automatic "trust new fp" flow.

- **Supply-chain attacks on the cryptographic libraries.** The SDK
  trusts `noise-protocol` (Node) and `cryptography` (Dart). Both are
  pinned; audit before upgrading.

## Pairing (v2.1)

v2.1 replaces the shared `token=` with a two-step public-key handshake
driven by the operator.

### What the app shows

In the "Add Remote Agent" screen, the app displays:

```
Your device public key
Fingerprint:  a1b2c3d4e5f6a7b8                    [Copy]
Public key:   MFswDQYJKoZIhvcN...                  [Copy]

To authorize this device, run on the agent host:
  shepaw-codebuddy-code peers add <pubkey> --label "iPhone 15 Pro"
```

The public key and fingerprint come from the app's persistent Noise
identity — they are stable across relaunches but wiped if the user
clears app data.

### What the operator does

**Option A — manual `peers add` (always available):**

1. Start the agent:
   ```sh
   shepaw-codebuddy-code serve --cwd /path/to/project
   ```
   Note the banner:
   ```
   Agent ID:         acp_agent_a1b2c3d4
   Fingerprint:      a1b2c3d4ffd6fa20
   Authorized peers: 0
   ⚠ No peers authorized. Run `shepaw-codebuddy-code peers add <pubkey>` to accept connections.
   ```
2. Receive the user's public key out of band (iMessage, Signal,
   shared secret store, etc.).
3. Authorize it:
   ```sh
   shepaw-codebuddy-code peers add <pubkey> --label "Alice's iPhone"
   ```
   The running agent picks up the change within ~100 ms — no restart.
4. Share the WS URL (including `#fp=<fingerprint>`) with the user.

**Option B — one-time pairing code (`enroll`, shorter flow):**

1. Start the agent as above.
2. Mint a pairing code:
   ```sh
   shepaw-codebuddy-code enroll --label "Alice's iPhone" \
       --base-url wss://channel.example.com/c/my-agent
   ```
   Output:
   ```
   ╭──────────────────────────────────────────────╮
   │  Pairing code:  4B7-9KX-M2P                  │
   ╰──────────────────────────────────────────────╯

     Valid until:  2026/4/25 11:11:39
     Single use:   the code is invalidated after first handshake.
     Agent ID:     acp_agent_a1b2c3d4
     Fingerprint:  a1b2c3d4ffd6fa20
     Pair URL:     wss://channel.example.com/c/my-agent/acp/ws?agentId=acp_agent_a1b2c3d4#fp=a1b2c3d4ffd6fa20
   ```
3. Share the URL **and** the `4B7-9KX-M2P` code with the user (any
   channel — both travel encrypted once the app connects; the code
   itself is bounded by its 10-minute TTL).
4. The user pastes the URL into the app and types the pairing code.
   On first handshake the agent consumes the code and auto-adds the
   user's device pubkey to `authorized_peers.json`. Later reconnects
   use the standard pubkey path — no code needed.

Codes are **single-use**, **10-minute TTL by default**, **31-char
alphabet** (no `0/1/I/L/O`), **stored 0600** in
`enrollments.json` alongside `identity.json`. They travel inside the
Noise-encrypted msg 1 payload — Channel Service sees AEAD ciphertext.
Revoke an unused code with `shepaw-codebuddy-code enroll-revoke <code>`;
list outstanding codes with `shepaw-codebuddy-code enroll-list`.

### QR code format

When `enroll --base-url <URL>` is invoked (or `shepaw-hub pair`), the
CLI prints a QR encoding a `shepaw://` deep-link:

```
shepaw://pair?url=<urlencoded WS URL incl. ?agentId=...#fp=...>
            &code=<urlencoded 9-char pairing code>
```

The Shepaw app's "Add remote agent" screen has a **scan** button that
opens the camera, parses this payload, and auto-fills both the URL and
the pairing code — the user only has to tap "Connect". Scanning with a
generic QR reader yields an unresolvable `shepaw://` URL that the OS
shows but can't open; this is harmless and the operator's fallback
remains "type the short code by hand".

**Security note**: the QR exposes the same information as the
printed URL + printed short code. A malicious passerby who photographs
the operator's terminal screen gains the same 10-minute attack window
they'd have if they photographed the printed short code. Treat both
with the same sensitivity.

### What happens on revocation

- Operator-initiated:
  ```sh
  shepaw-codebuddy-code peers remove a1b2c3d4e5f6a7b8
  ```
  Any currently-connected session for that peer is closed with `4411`
  within ~100 ms. The app surfaces this as "agent removed this device".

- User-initiated: deleting the agent row in the Shepaw app sends
  `peer.unregister` to the agent (best-effort). The agent removes the
  peer from its `authorized_peers.json` and closes the session with
  `4411`. If the app cannot reach the agent (offline, already
  closed), the local delete proceeds anyway; the operator may see a
  stale entry they can clean up manually.

### Pairing-time fingerprint verification

1. The app's "Add agent" screen shows the `#fp=` parsed out of the
   pasted URL. Verify it matches the fingerprint printed on the agent
   terminal's banner, character-for-character.
2. If the URL was received over an untrusted channel, read the
   fingerprint to the user over a voice call before pairing. An
   attacker needs to swap *both* the fingerprint on the URL and the
   public key they authorize on the agent host.

## Key rotation

### Rotating the agent's identity

Only do this if you believe the host was compromised, or if you need
to forcibly log out every paired device.

```sh
# 1. Stop the agent.
# 2. Remove the identity file:
rm ~/.config/shepaw-cb-gateway/identity.json
# or, if SHEPAW_IDENTITY_PATH is set, remove that file.
# (Leave authorized_peers.json alone if you want to re-authorize the same
#  set of apps after they re-pair; delete it for a full reset.)
# 3. Restart the agent.
```

On next start the agent prints a new `Agent ID` and `Fingerprint`.
Every paired Shepaw app will fail the next handshake with a
fingerprint-mismatch error dialog (WS `4403`). Each user must delete
the old agent entry in Shepaw and add the new URL (with the new
`#fp=`), and the operator must re-run `peers add` for each device
(the app's public key is unchanged, so they can re-use the existing
entries in `authorized_peers.json` if they didn't delete it).

### Rotating a phone's identity

The long-term X25519 keypair is stored under the
`shepaw.noise.static.v1` key in platform secure storage. Clearing
Shepaw's app data regenerates a fresh keypair on next launch. The
user must re-pair every agent (show new pubkey → operator runs
`peers add`). The operator should `peers remove` the old fingerprint
first if they don't want a stale entry.

### File permissions

The agent's `identity.json` and `authorized_peers.json` are written
with `0600` on Unix. If a file's permission bits are looser on load,
the SDK refuses to start rather than "fixing" them silently — this
catches accidental `chmod -R 755` of the config directory before it
leaks anything.

## Wire-level summary

| Close code | Meaning | Trigger |
|---|---|---|
| 4400 | bad envelope | Non-v2.1 framing or malformed JSON |
| 4403 | fingerprint mismatch | Pinned `#fp=` doesn't match agent's identity |
| 4404 | agentId mismatch | Claimed `agentId` doesn't match identity |
| 4405 | peer not authorized | Handshake OK but pubkey not in allowlist |
| 4409 | AEAD / replay | Ciphertext fails authentication or counter reused |
| 4411 | unregistered | Peer removed from allowlist while connected |

**Handshake payload fields** (inside Noise msg 1, encrypted):

| Field | When present | Meaning |
|---|---|---|
| `agentId` | always | Hint matching `acp_agent_<8-hex>`; 4404 if it contradicts the agent's identity |
| `clientVersion` | always | Human-readable, e.g. `"shepaw/v2.1"` |
| `enroll` | first pair only | 9-char code; consumed atomically on success, promoting this peer into `authorized_peers.json`. Subsequent reconnects omit the field. |

## Contact

Report vulnerabilities to `security@shepaw.com` (PGP on the website).
Please do not file public issues for unpatched vulnerabilities.
