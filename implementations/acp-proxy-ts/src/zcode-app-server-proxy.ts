/**
 * Stdio shim launched as `ZCODE_BIN` by zcode-acp-server.
 *
 * Forwards `zcode app-server --stdio` while answering
 * `session/requestRuntimePreferences` so session/create is not stuck on a
 * 15s client-request timeout.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import { replyForZcodeServerRequest } from './zcode-runtime-preferences.js';

const realBin = process.env.ZCODE_REAL_BIN?.trim();
if (realBin === undefined || realBin.length === 0) {
  process.stderr.write('zcode-app-server-proxy: ZCODE_REAL_BIN is required\n');
  process.exit(1);
}

const nodeBin = process.env.ZCODE_NODE?.trim() || process.execPath;
const child = spawn(nodeBin, [realBin, ...process.argv.slice(2)], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, ZCODE_BIN: realBin },
});

child.on('error', (err) => {
  process.stderr.write(`zcode-app-server-proxy: spawn failed: ${err.message}\n`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal !== null && signal !== undefined) {
    process.exit(1);
  }
  process.exit(code ?? 1);
});

if (child.stdin === null || child.stdout === null) {
  process.stderr.write('zcode-app-server-proxy: missing stdio pipes\n');
  process.exit(1);
}

process.stdin.pipe(child.stdin);

const rl = createInterface({ input: child.stdout });
rl.on('line', (line) => {
  const reply = replyForZcodeServerRequest(line);
  if (reply !== null) {
    child.stdin?.write(`${reply}\n`);
    return;
  }
  process.stdout.write(`${line}\n`);
});
rl.on('close', () => {
  process.stdout.end();
});
