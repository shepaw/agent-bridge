/**
 * Persistent store for peer tool-call approvals awaiting a phone decision.
 *
 * Survives hub restarts so a delayed `agent_approval_resp` can still be relayed
 * to the local agent via `agent.submitResponse`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { peerPendingApprovalsPath } from '../paths.js';
import { atomicWriteFile } from './atomic-write.js';
import type { ApprovalRequest } from './peer-acp-client.js';

export const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * How long a record is kept past its own expiry.
 *
 * Once an approval is expired nothing can act on it — the phone cannot answer
 * and a late `agent_approval_resp` is only meaningful while the request is
 * still live — so keeping the record past that only grows the file that every
 * approval event has to parse and rewrite whole.
 */
export const APPROVAL_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface PendingApprovalRecord {
  readonly approvalId: string;
  readonly peerId: string;
  readonly requestId: string;
  readonly agentId: string;
  readonly taskId: string;
  readonly prompt: string;
  readonly actions: ReadonlyArray<{ id: string; label?: string; style?: string }>;
  readonly toolKind?: string;
  readonly toolCallId?: string;
  readonly status: 'pending' | 'submitted' | 'expired';
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly selectedActionId?: string;
  readonly selectedActionLabel?: string;
}

interface StoreShape {
  readonly version: 1;
  readonly approvals: PendingApprovalRecord[];
}

function loadAll(): PendingApprovalRecord[] {
  const path = peerPendingApprovalsPath();
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as StoreShape;
    if (!Array.isArray(parsed.approvals)) return [];
    return parsed.approvals;
  } catch {
    return [];
  }
}

function persist(approvals: PendingApprovalRecord[]): void {
  const cutoff = Date.now() - APPROVAL_RETENTION_MS;
  const data: StoreShape = {
    version: 1,
    approvals: approvals.filter((a) => a.expiresAt > cutoff),
  };
  atomicWriteFile(peerPendingApprovalsPath(), JSON.stringify(data, null, 2));
}

export function savePendingApproval(record: PendingApprovalRecord): void {
  const existing = loadAll().filter((a) => a.approvalId !== record.approvalId);
  persist([record, ...existing]);
}

export function getPendingApproval(approvalId: string): PendingApprovalRecord | undefined {
  return loadAll().find((a) => a.approvalId === approvalId);
}

export function listPendingApprovalsForPeer(peerId: string): PendingApprovalRecord[] {
  const now = Date.now();
  return loadAll().filter(
    (a) => a.peerId === peerId && a.status === 'pending' && a.expiresAt > now,
  );
}

export function markPendingApprovalSubmitted(
  approvalId: string,
  selectedActionId: string,
  selectedActionLabel?: string,
): void {
  const next = loadAll().map((a) =>
    a.approvalId === approvalId
      ? {
          ...a,
          status: 'submitted' as const,
          selectedActionId,
          ...(selectedActionLabel !== undefined ? { selectedActionLabel } : {}),
        }
      : a,
  );
  persist(next);
}

export function expireStalePendingApprovals(): void {
  const now = Date.now();
  const next = loadAll().map((a) =>
    a.status === 'pending' && a.expiresAt <= now ? { ...a, status: 'expired' as const } : a,
  );
  persist(next);
}

export function pendingApprovalFromRequest(
  peerId: string,
  requestId: string,
  agentId: string,
  req: ApprovalRequest,
): PendingApprovalRecord {
  const now = Date.now();
  return {
    approvalId: req.confirmationId,
    peerId,
    requestId,
    agentId,
    taskId: req.taskId,
    prompt: req.prompt,
    actions: req.actions,
    ...(req.toolKind !== undefined ? { toolKind: req.toolKind } : {}),
    ...(req.toolCallId !== undefined ? { toolCallId: req.toolCallId } : {}),
    status: 'pending',
    createdAt: now,
    expiresAt: now + DEFAULT_APPROVAL_TTL_MS,
  };
}
