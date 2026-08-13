/**
 * Device-scoped store pouch card injected into the first ACP prompt of a
 * Shepaw session.
 *
 * The pouch is the device's `store://<space>/<device_id>/…` tree. Placement
 * is by space partition, not by "user bag" vs "agent bag".
 */

import { storeBackendConfigured } from './shepaw-cli-shim.js';

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

export function buildStorePouchCard(opts: { deviceId?: string } = {}): string {
  const device = opts.deviceId?.trim();
  const deviceLine = device
    ? `本机 device_id：\`${device}\`（URI 形如 \`store://files/${device}/…\`）`
    : '本机 device_id 以 store 工具返回值为准，禁止编造或拼接。';

  return [
    '## 本机储物袋',
    '',
    '储物袋是这台设备上的 store，不是用户/agent 各一只袋子。',
    'URI：`store://<space>/<device_id>/<path>`',
    deviceLine,
    '',
    '分区规约（按空间写入）：',
    '- `files` — 沉淀区（安装包、要长期留在设备上的文件）',
    '- `public` — 公开引用（可不复制 files 字节）',
    '- `runtime` — 当前会话产物（`store write` 默认落点）',
    '- `memory` — Soul / 结构化记忆',
    '- `workspaces` — owner 跨设备工作区',
    '- `backups` — 仅本端灾备',
    '',
    '读写用 `store_*` MCP 或 `shepaw store list|read|write`；原样引用返回的 `store://`。',
    '不要发明 URI，不要用 OS 路径代替储物袋。',
    '未指定分区时：长期文件 → `files`；本轮中间产物 → `runtime`。',
  ].join('\n');
}

/** Prepend the card as its own text block so the user message stays intact. */
export function prependStorePouchCard<T extends { type: string }>(
  blocks: readonly T[],
  card: string,
): T[] {
  const text = card.trim();
  if (!text) return [...blocks];
  const head = { type: 'text', text } as T;
  return [head, ...blocks];
}
