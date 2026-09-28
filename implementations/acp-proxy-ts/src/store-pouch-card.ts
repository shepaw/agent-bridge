/**
 * Device / scope pouch card for Hub ACP sessions (stable section).
 *
 * Injected via `session/new` `_meta.systemPrompt` when the engine supports it
 * (Phase 2), otherwise prepended to each user prompt (Phase 1 fallback).
 * Transcript export always strips it before sync to the App.
 *
 * Card text v2 (space semantics + real write targets):
 * `../../../../docs/store-pouch-card-v2-decision.md`.
 * Aligned with shepaw `ScopeCard` schema_version=1
 * (`.ai_workspace/AGENT_SCOPE_CARD_DESIGN.md`):
 * - Prefer host-provided markdown via `SHEPAW_SCOPE_CARD` (full override).
 * - Otherwise build an ACP-mode card (device-scoped, cognition not memory).
 *
 * Disable with SHEPAW_STORE_POUCH_CARD=0|false|off.
 */

import { storeBackendConfigured } from './shepaw-cli-shim.js';

export const SCOPE_CARD_SCHEMA_VERSION = 1;

export const SCOPE_CARD_STABLE_HEADER = '## 当前储物袋作用域';

/** Last stable card bullet. Transcript stripping peels user text glued after it.
 * Exported so the card text and the stripper cannot drift apart. */
export const SCOPE_CARD_LAST_BULLET =
  '- 禁止: 编造 `store://`；用 OS 路径代替储物袋；回写 runtime 镜像当权威；用 `store write` 写 `files` / `cognition`';

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
  /** Fixed store URI of this agent's resume document (store read/write). */
  resumeUri?: string;
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
    ? `- 工作区已挂载：\`${workspace}\`（挂载视图：与磁盘同一份，改磁盘即改袋；相对路径如 \`docs/good.md\` = 挂载根下；不版本、不镜像、不跨设备；不要用 \`..\`）`
    : '';
  const resume = opts.resumeUri?.trim();
  const resumeLine = resume
    ? `- 简历：\`${resume}\` — 仅在被要求查看/更新简历时用 store read / store write 读写；日常对话不要读取。修改时更新 \`## Summary\`（给分派者看的能力说明），持久手工补充写在 \`## 自我补充 / Self Notes\` 段内`
    : '';

  return [
    SCOPE_CARD_STABLE_HEADER,
    '',
    `- schema: v${SCOPE_CARD_SCHEMA_VERSION} · mode: \`acp\` · owner: device`,
    deviceLine,
    '- URI：`store://<space>/<device_id>/<path>`（可加 `@v<n>` / `@<hash>` 固定到某一版本）',
    ...(workspaceLine ? [workspaceLine] : []),
    ...(resumeLine ? [resumeLine] : []),
    '',
    '- 写只认三个落点：`runtime`（默认，`runtime/…/artifacts/<task>/`）· `public`（`--space public`）· `workspaces`（`--space workspaces --group <gid>`，仅成员）',
    '- 只读 / 勿写：`files` 沉淀区只读（`--space files` 会静默落到 `runtime`）；`cognition`（Soul + 记忆补充：不同步，靠 agent 主动写；日常记忆优先写文件系统记忆）与 `backups`（本端灾备）私有勿写',
    '- 读: `shepaw store read --uri <uri-as-is>` · 列: `shepaw store list --uri <uri> --depth 1`（`--depth 0` 递归）',
    '- 找: `shepaw store search --query <关键词> [--space files] [--uri <前缀>]` — 找不到就 search，不要猜 URI',
    '- 写产物: `shepaw store write --filename <名> --content "..."`（本地文件用 `--file <path>`，二进制用 `--content-base64`；可选 `--task` / `--desc`）；**不要**传 `agent_id` / `owner`，**以返回的 `store://` 为准**，不要自己拼落点',
    '- `shepaw` 由本宿主注入 PATH（Hub shim，不是 Homebrew/npm 包）。直接跑 `shepaw …`；若 shell 报 command not found，用 `"$SHEPAW_BIN"` 同样调用。不要在 /opt/homebrew 或 /usr/local 里找发行版',
    '- 本宿主 `shepaw store` 只直接碰本机 device；其他 `store://` 与 `os` / `chat` / `context` / `events` 由 shim 转到配对 App。不要 `hub.cli.execute`',
    SCOPE_CARD_LAST_BULLET,
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
