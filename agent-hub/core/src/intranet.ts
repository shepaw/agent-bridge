/**
 * Tencent-intranet-only engines (TClaude / TCodex / Knot) stay hidden unless
 * this machine looks like it can actually reach that network — or the
 * operator forces the catalog via SHEPAW_HUB_TENCENT_INTRANET.
 */

import { spawnSync } from 'node:child_process';
import { promises as dns } from 'node:dns';

import {
  BUILTIN_ENGINE_CATALOG,
  findBuiltinEngineDefinition,
  type BuiltinEngineDefinition,
} from './engine-catalog.js';

export const TENCENT_INTRANET_ENV = 'SHEPAW_HUB_TENCENT_INTRANET';

const PROBE_HOSTS = ['d.woa.com', 'km.woa.com', 'idc.oa.com'] as const;
const DNS_TIMEOUT_MS = 800;

let cached: boolean | undefined;
let inflight: Promise<boolean> | undefined;

export function resetTencentIntranetCacheForTests(): void {
  cached = undefined;
  inflight = undefined;
}

export function tencentIntranetEnvOverride(): boolean | undefined {
  const raw = process.env[TENCENT_INTRANET_ENV]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return undefined;
  if (raw === '1' || raw === 'true' || raw === 'yes') return true;
  if (raw === '0' || raw === 'false' || raw === 'no') return false;
  return undefined;
}

export function peekTencentIntranet(): boolean | undefined {
  return cached;
}

export function isIntranetOnlyEngine(id: string): boolean {
  return findBuiltinEngineDefinition(id)?.intranetOnly === true;
}

/** Catalog visibility after {@link detectTencentIntranet} (or an env override). */
export function isIntranetEngineVisible(id: string): boolean {
  if (!isIntranetOnlyEngine(id)) return true;
  const forced = tencentIntranetEnvOverride();
  if (forced === false) return false;
  if (forced === true) return true;
  return cached === true;
}

export async function detectTencentIntranet(): Promise<boolean> {
  const forced = tencentIntranetEnvOverride();
  if (forced !== undefined) {
    cached = forced;
    return forced;
  }
  if (cached !== undefined) return cached;
  if (inflight !== undefined) return inflight;

  inflight = probeIntranet()
    .then((value) => {
      cached = value;
      return value;
    })
    .finally(() => {
      inflight = undefined;
    });
  return inflight;
}

async function probeIntranet(): Promise<boolean> {
  if (anyIntranetCliPresent()) return true;
  for (const host of PROBE_HOSTS) {
    if (await lookupHost(host)) return true;
  }
  return false;
}

function anyIntranetCliPresent(): boolean {
  for (const entry of BUILTIN_ENGINE_CATALOG as readonly BuiltinEngineDefinition[]) {
    if (entry.intranetOnly === true && commandExists(entry.checkBinary)) return true;
  }
  return false;
}

function commandExists(name: string): boolean {
  if (name.length === 0) return false;
  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const result = spawnSync(whichCmd, [name], { encoding: 'utf8' });
    return result.status === 0 && Boolean(result.stdout.trim());
  } catch {
    return false;
  }
}

async function lookupHost(host: string): Promise<boolean> {
  try {
    await Promise.race([
      dns.lookup(host),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('timeout')), DNS_TIMEOUT_MS);
      }),
    ]);
    return true;
  } catch {
    return false;
  }
}
