/**
 * Built-in default avatars for ACP engines.
 *
 * Assets live in this package (`assets/engines/<id>.svg`) and are pushed to
 * Shepaw peers as `avatar_data` (base64) so the app does not need bundled copies.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUILTIN_ENGINE_IDS, type BuiltinAgentEngine, isBuiltinEngine } from './engines.js';

export const GENERIC_DEFAULT_AVATAR = '🤖';

/** Logical avatar marker sent alongside `avatar_data` (not a filesystem path). */
export function engineAvatarMarker(engineId: string): string {
  return `engine-avatar:${engineId}`;
}

export interface EngineAvatarPayload {
  readonly avatar: string;
  readonly avatar_data: string;
  readonly avatar_ext: string;
}

function candidateAssetDirs(): string[] {
  const dirs: string[] = [];
  const push = (dir: string | undefined) => {
    if (dir && !dirs.includes(dir)) dirs.push(dir);
  };

  // ESM / tsup ESM bundle: resolve relative to this module file.
  try {
    const metaUrl = import.meta.url;
    if (typeof metaUrl === 'string' && metaUrl.length > 0) {
      const here = dirname(fileURLToPath(metaUrl));
      push(join(here, 'assets', 'engines'));
      push(join(here, '..', 'assets', 'engines'));
      push(join(here, '..', '..', 'assets', 'engines'));
    }
  } catch {
    // ignore — fall through to other candidates
  }

  // CJS / require(): __dirname is injected by the CJS bundle.
  try {
    // eslint-disable-next-line no-undef
    const cjsDir = typeof __dirname === 'string' ? __dirname : undefined;
    if (cjsDir) {
      push(join(cjsDir, 'assets', 'engines'));
      push(join(cjsDir, '..', 'assets', 'engines'));
      push(join(cjsDir, '..', '..', 'assets', 'engines'));
    }
  } catch {
    // ignore
  }

  // Installed package root via require.resolve (when published / linked).
  try {
    const req = createRequire(
      typeof import.meta.url === 'string' && import.meta.url
        ? import.meta.url
        : join(process.cwd(), 'package.json'),
    );
    const pkgJson = req.resolve('@shepaw/agent-hub-core/package.json');
    push(join(dirname(pkgJson), 'assets', 'engines'));
  } catch {
    // ignore — local path / monorepo without package resolution
  }

  // Monorepo / test cwd fallbacks
  push(join(process.cwd(), 'assets', 'engines'));
  push(join(process.cwd(), 'agent-hub', 'core', 'assets', 'engines'));

  return dirs;
}

function engineAssetsDir(): string | undefined {
  for (const dir of candidateAssetDirs()) {
    if (existsSync(dir)) return dir;
  }
  return undefined;
}

/** Resolve on-disk path for an engine avatar file, if present. */
export function resolveEngineAvatarFile(engineId: string): string | undefined {
  const dir = engineAssetsDir();
  if (!dir) return undefined;
  const svg = join(dir, `${engineId}.svg`);
  if (existsSync(svg)) return svg;
  const png = join(dir, `${engineId}.png`);
  if (existsSync(png)) return png;
  return undefined;
}

/** Load engine avatar bytes for peer `agent_list_resp` (avatar + avatar_data). */
export function loadEngineAvatarPayload(
  engineId: string | undefined | null,
): EngineAvatarPayload | undefined {
  if (!engineId) return undefined;
  const file = resolveEngineAvatarFile(engineId);
  if (!file) return undefined;
  try {
    const bytes = readFileSync(file);
    if (bytes.length === 0) return undefined;
    const ext = file.endsWith('.png') ? 'png' : 'svg';
    return {
      avatar: engineAvatarMarker(engineId),
      avatar_data: bytes.toString('base64'),
      avatar_ext: ext,
    };
  } catch {
    return undefined;
  }
}

/** Resolve the default avatar string for an engine id (builtin or custom). */
export function defaultAvatarForEngine(engineId: string | undefined | null): string {
  if (!engineId) return GENERIC_DEFAULT_AVATAR;
  if (resolveEngineAvatarFile(engineId)) return engineAvatarMarker(engineId);
  if (isBuiltinEngine(engineId)) return engineAvatarMarker(engineId);
  return GENERIC_DEFAULT_AVATAR;
}

/** Builtin engines that currently have a file under `assets/engines/`. */
export function listBundledEngineAvatarIds(): string[] {
  const dir = engineAssetsDir();
  if (!dir) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.svg') || name.endsWith('.png'))
    .map((name) => name.replace(/\.(svg|png)$/i, ''));
}

/** @deprecated Prefer {@link engineAvatarMarker} / {@link loadEngineAvatarPayload}. */
export const BUILTIN_ENGINE_AVATARS: Record<BuiltinAgentEngine, string> = Object.fromEntries(
  BUILTIN_ENGINE_IDS.map((id) => [id, engineAvatarMarker(id)]),
) as Record<BuiltinAgentEngine, string>;
