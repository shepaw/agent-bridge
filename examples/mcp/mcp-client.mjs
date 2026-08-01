#!/usr/bin/env node
/**
 * Zero-dependency MCP smoke client for `nexuspouch mcp`.
 * Usage: node mcp-client.mjs --root <root> [--token <token>] [--listen :8787]
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const opt = (name, fallback = undefined) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const root = opt("--root");
if (!root) {
  console.error("usage: node mcp-client.mjs --root <root> [--token <token>]");
  process.exit(1);
}

const mcpArgs = ["mcp", "--root", root];
if (opt("--listen")) mcpArgs.push("--listen", opt("--listen"));
if (opt("--token")) mcpArgs.push("--token", opt("--token"));

const child = spawn("nexuspouch", mcpArgs, { stdio: ["pipe", "pipe", "inherit"] });
const rl = createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? p.reject(msg.error) : p.resolve(msg.result);
  }
});

child.stdin.on("error", (e) => {
  console.error("stdin error:", e.message);
  process.exit(1);
});

const toolText = (result) => result?.content?.[0]?.text ?? "{}";

try {
  const init = await call("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-client-example" },
  });
  console.log("initialize:", JSON.stringify(init.serverInfo));

  const tools = await call("tools/list");
  console.log(
    "tools:",
    tools.tools.map((t) => t.name).join(", "),
  );

  const written = await call("tools/call", {
    name: "store_write",
    arguments: { filename: "hello.txt", content: "hello from mcp-client.mjs", task: "demo" },
  });
  const uri = JSON.parse(toolText(written)).uri;
  console.log("store_write ->", uri);

  const read = await call("tools/call", { name: "store_read", arguments: { uri } });
  console.log("store_read ->", toolText(read));

  const meta = await call("tools/call", { name: "store_meta", arguments: { uri } });
  console.log("store_meta ->", toolText(meta));
} catch (e) {
  console.error("MCP call failed:", JSON.stringify(e));
  process.exitCode = 1;
} finally {
  child.stdin.end();
}
