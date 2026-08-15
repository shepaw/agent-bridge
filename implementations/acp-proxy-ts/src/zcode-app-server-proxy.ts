/**
 * Stdio shim launched as `ZCODE_BIN` by zcode-acp-server.
 *
 * Forwards `zcode app-server --stdio` while answering headless-only
 * server→client requests and overlaying a non-captcha runtime model.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import {
  loadZcodeDesktopCredentials,
  overlayZcodeDesktopCredentials,
} from './zcode-desktop-credentials.js';
import { ZcodeStdioInterceptor } from './zcode-stdio-interceptor.js';

const realBin = process.env.ZCODE_REAL_BIN?.trim();
if (realBin === undefined || realBin.length === 0) {
  process.stderr.write('zcode-app-server-proxy: ZCODE_REAL_BIN is required\n');
  process.exit(1);
}

const creds = loadZcodeDesktopCredentials();
const interceptor = new ZcodeStdioInterceptor(creds);
const nodeBin = process.env.ZCODE_NODE?.trim() || process.execPath;
const child = spawn(nodeBin, [realBin, ...process.argv.slice(2)], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: overlayZcodeDesktopCredentials({ ...process.env, ZCODE_BIN: realBin }, creds),
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

const inbound = createInterface({ input: process.stdin });
inbound.on('line', (line) => {
  child.stdin?.write(`${interceptor.inbound(line)}\n`);
});
inbound.on('close', () => {
  child.stdin?.end();
});

let flushTimer: ReturnType<typeof setTimeout> | undefined;
const rl = createInterface({ input: child.stdout });
rl.on('line', (line) => {
  const out = interceptor.outbound(line);
  if (out.toChild !== undefined) {
    child.stdin?.write(`${out.toChild}\n`);
  }
  if (out.holdCreate === true) {
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      const held = interceptor.flushHeldCreate();
      if (held !== null) process.stdout.write(`${held}\n`);
    }, 8000);
  }
  if (out.forward !== undefined) {
    if (flushTimer !== undefined && !interceptor.isHoldingCreate()) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    process.stdout.write(`${out.forward}\n`);
  }
});
rl.on('close', () => {
  process.stdout.end();
});
