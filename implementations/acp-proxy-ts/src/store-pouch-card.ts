/**
 * Device / scope pouch card injected into the first ACP prompt of a Shepaw
 * session.
 *
 * Aligned with shepaw `ScopeCard` schema_version=1
 * (`.ai_workspace/AGENT_SCOPE_CARD_DESIGN.md`):
 * - Prefer host-provided markdown via `SHEPAW_SCOPE_CARD` (full override).
 * - Otherwise build an ACP-mode card (device-scoped, cognition not memory).
 *
 * Disable with SHEPAW_STORE_POUCH_CARD=0|false|off.
 */

import { storeBackendConfigured } from './shepaw-cli-shim.js';

export const SCOPE_CARD_SCHEMA_VERSION = 1;

/** Disable with SHEPAW_STORE_POUCH_CARD=0|false|off. */
export function pouchCardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = (env.SHEPAW_STORE_POUCH_CARD ?? '').trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off') return false;
  return storeBackendConfigured(env);
}

export function resolveStoreDeviceIdFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const explicit = (
    env.SHEPAW_HUB_STORE_DEVICE ??
    env.NEXUSPOUCH_DEVICE ??
    ''
  ).trim();
  return explicit.length > 0 ? explicit : undefined;
}

/**
 * Host can pass a full Scope Card markdown (stable section). When set, bridge
 * must not invent a second long pouch manual.
 */
export function resolveHostScopeCardMarkdown(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = (env.SHEPAW_SCOPE_CARD ?? '').trim();
  return raw.length > 0 ? raw : undefined;
}

export function buildStorePouchCard(opts: {
  deviceId?: string;
  workspaceUri?: string;
  /** Pre-rendered host Scope Card; wins over local template. */
  hostCardMarkdown?: string;
} = {}): string {
  const host = opts.hostCardMarkdown?.trim();
  if (host) return host;

  const device = opts.deviceId?.trim();
  const deviceLine = device
    ? `- device: \`${device}\``
    : '- device: 以 store 工具返回值为准，禁止编造或拼接';
  const workspace = opts.workspaceUri?.trim();
  const workspaceLine = workspace
    ? `- 工作区已挂载：\`${workspace}\`（相对路径如 \`docs/good.md\` 即该目录下文件）`
    : '';

  return [
    '## 当前储物袋作用域',
    '',
    `- schema: v${SCOPE_CARD_SCHEMA_VERSION} · mode: \`acp\` · owner: device`,
    deviceLine,
    '- URI：`store://<space>/<device_id>/<path>`',
    ...(workspaceLine ? [workspaceLine] : []),
    '',
    '- 分区：`files` 沉淀 · `public` 公开引用 · `runtime` 会话产物 · `cognition` Soul/结构化记忆权威 · `workspaces` 工作区 · `backups` 本端灾备',
    '- 读: `shepaw store read --uri <uri-as-is>` · 列: `shepaw store list --uri <uri> --depth 1`',
    '- 写产物: `shepaw store write --filename <名> --content "..."`（可选 `--task` / `--desc` / `--space public`）；**不要**传 `agent_id` / `owner`，由系统落到本作用域袋',
    '- 禁止: 编造 `store://`；用 OS 路径代替储物袋；回写 runtime 镜像当权威',
    '- 未指定分区时：长期文件 → `files`；本轮中间产物 → `runtime`',
  ].join('\n');
}

/** Prepend the card as its own text block so the user message stays intact. */
export function prependStorePouchCard<T extends { type: string }>(
  blocks: readonly T[],
  card: string,
): T[] {
  const text = card.trim();
  if (!text) return [...blocks];
  const head = { type: 'text', text } as unknown as T;
  return [head, ...blocks];
}
