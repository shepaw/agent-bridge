/**
 * Shared tool-call approval policy parser.
 *
 * Used by the gateway (device-wide), engine (per-engine), and instance
 * (per-instance) routes so the body shape stays identical everywhere.
 */

import { type ApprovalMode, type ApprovalPolicyConfig } from '@shepaw/agent-hub-core';

export const VALID_KINDS = new Set([
  'read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other',
]);

/** Validate + normalize an approval policy from an untrusted request body. */
export function parseApprovalBody(body: Record<string, unknown>): ApprovalPolicyConfig {
  const rawMode = typeof body.mode === 'string' ? body.mode : 'custom';
  if (rawMode !== 'ask' && rawMode !== 'auto' && rawMode !== 'custom') {
    throw new Error('mode must be one of: ask, auto, custom.');
  }
  const kinds = (v: unknown, label: string): string[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw new Error(`${label} must be an array of tool kinds.`);
    const out = v.map((x) => String(x).trim().toLowerCase()).filter((x) => x.length > 0);
    for (const k of out) {
      if (!VALID_KINDS.has(k)) throw new Error(`Invalid tool kind "${k}" in ${label}.`);
    }
    return out;
  };
  const strs = (v: unknown, label: string): string[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw new Error(`${label} must be an array of strings.`);
    return v.map((x) => String(x).trim()).filter((x) => x.length > 0);
  };
  return {
    mode: rawMode as ApprovalMode,
    allowKinds: kinds(body.allowKinds, 'allowKinds'),
    askKinds: kinds(body.askKinds, 'askKinds'),
    allowPatterns: strs(body.allowPatterns, 'allowPatterns'),
    denyPatterns: strs(body.denyPatterns, 'denyPatterns'),
  };
}
