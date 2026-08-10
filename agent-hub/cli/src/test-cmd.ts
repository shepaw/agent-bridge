/**
 * `shepaw-hub test` — verify that registered instances are reachable end-to-end.
 *
 * Levels:
 *   (default)  HTTP /status|/health via probeInstanceRuntime
 *   --rpc      + Noise WS + agent.sessions.list (hub peer identity)
 *   --chat     + agent.chat round-trip (auto-approves tool calls)
 *
 * Exit code 1 if any selected instance fails the requested level.
 */

import {
  chatInstanceAcpRpc,
  closeInstanceAcpRpcClient,
  getInstance,
  InstanceGatewayOfflineError,
  InstanceNotFoundError,
  loadOrCreateHubConfig,
  pingInstanceAcpRpc,
  probeInstanceRuntime,
  type InstanceConfig,
} from '@shepaw/agent-hub-core';

export interface TestOptions {
  /** Also open a Noise WS and call agent.sessions.list. */
  rpc?: boolean;
  /** Also send an agent.chat turn (implies --rpc). */
  chat?: boolean;
  /** Override the probe chat message. */
  message?: string;
  /** Chat timeout in ms (default 60000). */
  timeoutMs?: number;
}

interface CheckResult {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

const DEFAULT_CHAT_MESSAGE =
  'This is a Shepaw hub connectivity test. Reply with exactly the word: pong';

function summarizeHttp(st: Awaited<ReturnType<typeof probeInstanceRuntime>>): { ok: boolean; detail: string } {
  const bits = [`availability=${st.availability}`];
  if (st.pid !== null) bits.push(`pid=${st.pid}`);
  if (st.acpConnected !== null) bits.push(`acp=${st.acpConnected}`);
  if (st.busyLevel !== null) bits.push(`busy=${st.busyLevel}`);
  if (st.probeError) bits.push(`probe=${st.probeError}`);

  const ok = st.availability === 'online' || st.availability === 'starting';
  return { ok, detail: bits.join(' ') };
}

async function testOne(instance: InstanceConfig, opts: TestOptions): Promise<CheckResult> {
  const id = instance.id;
  const label = instance.label;

  const runtime = await probeInstanceRuntime(instance);
  const http = summarizeHttp(runtime);
  if (!http.ok) {
    return { id, label, ok: false, detail: `HTTP ✗  ${http.detail}` };
  }

  const wantRpc = opts.rpc === true || opts.chat === true;
  if (!wantRpc) {
    return { id, label, ok: true, detail: `HTTP ✓  ${http.detail}` };
  }

  let rpcDetail = '';
  try {
    const ping = await pingInstanceAcpRpc(id);
    rpcDetail = `RPC ✓  sessions=${ping.sessionCount}`;
  } catch (err) {
    closeInstanceAcpRpcClient(id);
    const msg =
      err instanceof InstanceGatewayOfflineError || err instanceof Error
        ? err.message
        : String(err);
    return { id, label, ok: false, detail: `HTTP ✓  RPC ✗  ${msg}` };
  }

  if (opts.chat !== true) {
    // Drop the pooled Noise client so the CLI can exit (heartbeat keeps the event loop alive).
    closeInstanceAcpRpcClient(id);
    return { id, label, ok: true, detail: `HTTP ✓  ${rpcDetail}` };
  }

  const message = opts.message && opts.message.length > 0 ? opts.message : DEFAULT_CHAT_MESSAGE;
  const chat = await chatInstanceAcpRpc(id, message, { timeoutMs: opts.timeoutMs });
  // chatInstanceAcpRpc already closes the pool entry in finally.
  if (!chat.ok) {
    return {
      id,
      label,
      ok: false,
      detail: `HTTP ✓  ${rpcDetail}  chat ✗  ${chat.error ?? 'unknown'} (${chat.elapsedMs}ms)`,
    };
  }

  const preview = chat.reply.replace(/\s+/g, ' ').trim().slice(0, 80);
  return {
    id,
    label,
    ok: true,
    detail: `HTTP ✓  ${rpcDetail}  chat ✓  "${preview}" (${chat.elapsedMs}ms)`,
  };
}

/** Run connectivity tests. Returns the number of failing instances. */
export async function runTest(id: string | undefined, opts: TestOptions = {}): Promise<number> {
  const cfg = loadOrCreateHubConfig();
  let instances: InstanceConfig[];
  if (id !== undefined) {
    try {
      instances = [getInstance(cfg, id)];
    } catch (err) {
      if (err instanceof InstanceNotFoundError) {
        console.error(err.message);
        return 1;
      }
      throw err;
    }
  } else {
    instances = [...cfg.instances];
  }

  if (instances.length === 0) {
    console.log('No instances registered. Run `shepaw-hub quickstart` first.');
    return 1;
  }

  const level =
    opts.chat === true ? 'HTTP + RPC + chat' : opts.rpc === true ? 'HTTP + RPC' : 'HTTP';
  console.log(`shepaw-hub test (${level}) — ${instances.length} instance(s)\n`);

  let failures = 0;
  for (const instance of instances) {
    const result = await testOne(instance, opts);
    const mark = result.ok ? '✓' : '✗';
    console.log(`${mark} ${result.id}  (${result.label})`);
    console.log(`  ${result.detail}`);
    if (!result.ok) failures += 1;
  }

  console.log(`\n${failures} failure(s), ${instances.length - failures} ok.`);
  return failures;
}
