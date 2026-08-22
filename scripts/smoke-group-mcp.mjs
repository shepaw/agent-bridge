#!/usr/bin/env node
/**
 * Smoke test: group orchestration tools on the store MCP, end to end.
 *
 * Spins a mock hub store HTTP server, spawns the real `peer-store-mcp`
 * stdio server with group env, drives initialize → tools/list →
 * tools/call (group_dispatch + group_mention) over JSON-RPC, and asserts
 * the calls are persisted to the orchestration inbox via the store
 * protocol (write.begin/chunk/commit).
 *
 * Requires the acp-proxy dist build (npm run build -w implementations/acp-proxy-ts).
 *
 * Usage: node scripts/smoke-group-mcp.mjs
 * Exit 0 on pass, 1 on failure.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const proxyDist = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'implementations',
  'acp-proxy-ts',
  'dist',
);

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

/** Mock hub: /api/v1/health + /api/v1/store write pipeline recorder. */
async function startMockHub() {
  const writes = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const send = (obj) => {
        const body = JSON.stringify(obj);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(body);
      };
      if (req.url === '/api/v1/health') {
        send({ device: 'hubdev1234' });
        return;
      }
      if (req.method === 'POST' && req.url === '/api/v1/store') {
        const { op, payload } = JSON.parse(raw);
        if (op === 'write.begin') {
          const uploadId = `up_${writes.length}`;
          writes.push({
            path: payload.path,
            space: payload.space,
            chunks: [],
          });
          send({ op: 'result', data: { upload_id: uploadId } });
          return;
        }
        if (op === 'write.chunk') {
          const w = writes[writes.length - 1];
          w.chunks.push(Buffer.from(payload.data, 'base64'));
          send({ op: 'result', data: { received: payload.data.length } });
          return;
        }
        if (op === 'commit') {
          send({ op: 'result', data: { ok: true } });
          return;
        }
        send({ op: 'error', code: 'bad_op' });
        return;
      }
      res.writeHead(404);
      res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, writes, close: () => server.close() };
}

/** Spawn the real peer-store-mcp server and return a JSON-RPC client. */
function spawnMcp(env) {
  const child = spawn(process.execPath, [join(proxyDist, 'peer-store-mcp.js')], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const pending = new Map();
  let nextId = 1;
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        p(msg);
      }
    }
  });
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`timeout: ${method}`));
      }, 10000);
    });
  const close = () => child.kill();
  return { call, close };
}

const groupEnv = {
  SHEPAW_HUB_STORE_URL: '',
  GROUP_ID: 'group_abc',
  GROUP_SESSION_ID: 'group_session_1',
  GROUP_WORKSPACE_ROOT: 'group_group_abc',
  GROUP_MEMBER_NAMES: 'She,Coder',
};

const hub = await startMockHub();
groupEnv.SHEPAW_HUB_STORE_URL = hub.base;
console.log(`mock hub at ${hub.base}`);

const mcp = spawnMcp(groupEnv);
try {
  console.log('initialize:');
  const init = await mcp.call('initialize');
  check('server identifies as shepaw-peer-store',
    init.result?.serverInfo?.name === 'shepaw-peer-store',
    JSON.stringify(init.result?.serverInfo));

  console.log('tools/list:');
  const listed = await mcp.call('tools/list');
  const tools = listed.result.tools.map((t) => t.name);
  check('store_write present', tools.includes('store_write'));
  check('group_dispatch present', tools.includes('group_dispatch'));
  check('group_finish present', tools.includes('group_finish'));
  check('group_mention present', tools.includes('group_mention'));

  console.log('tools/call group_dispatch:');
  const dispatch = await mcp.call('tools/call', {
    name: 'group_dispatch',
    arguments: {
      mode: 'sequential',
      steps: [{ step: 1, agents: ['Coder'], task: '实现登录' }],
    },
  });
  check('dispatch ok', dispatch.result?.isError === false,
    JSON.stringify(dispatch.result?.content?.[0]?.text));
  const dispatchText = dispatch.result?.content?.[0]?.text ?? '';
  check('dispatch reply carries ok + workspace uri',
    /"ok"\s*:\s*true/.test(dispatchText) &&
      /store:\/\/workspaces\//.test(dispatchText),
    dispatchText.slice(0, 120));

  console.log('tools/call group_mention:');
  const mention = await mcp.call('tools/call', {
    name: 'group_mention',
    arguments: { mentions: [{ name: 'She', notify: true, reason: '确认方案' }] },
  });
  check('mention ok', mention.result?.isError === false,
    JSON.stringify(mention.result?.content?.[0]?.text));

  console.log('hub writes:');
  check('two inbox files written', hub.writes.length === 2, `got ${hub.writes.length}`);
  const [dispatchWrite, mentionWrite] = hub.writes;
  check('dispatch path', dispatchWrite?.path ===
    'group_group_abc/shared/orchestration/group_session_1/inbox/dispatch.json',
    dispatchWrite?.path);
  check('mention path', mentionWrite?.path ===
    'group_group_abc/shared/orchestration/group_session_1/inbox/mentions.json',
    mentionWrite?.path);
  check('space is workspaces',
    dispatchWrite?.space === 'workspaces', dispatchWrite?.space);

  const dispatchBody = JSON.parse(
    Buffer.concat(dispatchWrite.chunks).toString('utf8'),
  );
  check('dispatch body has issued_at', typeof dispatchBody.issued_at === 'string',
    String(dispatchBody.issued_at));
  check('dispatch body has steps',
    dispatchBody.steps?.[0]?.task === '实现登录',
    JSON.stringify(dispatchBody.steps));
  check('dispatch mode sequential', dispatchBody.mode === 'sequential');

  const mentionBody = JSON.parse(
    Buffer.concat(mentionWrite.chunks).toString('utf8'),
  );
  check('mention body has declaration',
    mentionBody.mentions?.[0]?.name === 'She',
    JSON.stringify(mentionBody.mentions));
} catch (e) {
  failures += 1;
  console.error(`  ✗ smoke run failed: ${e.message}`);
} finally {
  mcp.close();
  await hub.close();
}

if (failures > 0) {
  console.error(`\nsmoke-group-mcp: ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nsmoke-group-mcp: all checks passed');
