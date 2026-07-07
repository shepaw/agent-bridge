import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  expireStalePendingApprovals,
  getPendingApproval,
  listPendingApprovalsForPeer,
  markPendingApprovalSubmitted,
  pendingApprovalFromRequest,
  savePendingApproval,
} from '../src/peer/peer-pending-approvals.js';

describe('peer-pending-approvals', () => {
  let hubHome: string;
  const prev = process.env.SHEPAW_HUB_HOME;

  beforeEach(() => {
    hubHome = mkdtempSync(join(tmpdir(), 'shepaw-hub-test-'));
    process.env.SHEPAW_HUB_HOME = hubHome;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.SHEPAW_HUB_HOME;
    else process.env.SHEPAW_HUB_HOME = prev;
    rmSync(hubHome, { recursive: true, force: true });
  });

  it('persists and retrieves pending approvals', () => {
    const record = pendingApprovalFromRequest('peer-1', 'req-1', 'agent-a', {
      confirmationId: 'conf-1',
      taskId: 'task-1',
      prompt: 'Allow?',
      actions: [{ id: 'allow', label: 'Allow' }],
    });
    savePendingApproval(record);
    const loaded = getPendingApproval('conf-1');
    expect(loaded?.peerId).toBe('peer-1');
    expect(loaded?.agentId).toBe('agent-a');
    expect(loaded?.status).toBe('pending');
  });

  it('marks submitted and lists pending for peer', () => {
    const record = pendingApprovalFromRequest('peer-2', 'req-2', 'agent-b', {
      confirmationId: 'conf-2',
      taskId: 'task-2',
      prompt: 'Run?',
      actions: [{ id: 'deny', label: 'Deny' }],
    });
    savePendingApproval(record);
    markPendingApprovalSubmitted('conf-2', 'deny', 'Deny');
    expect(listPendingApprovalsForPeer('peer-2')).toHaveLength(0);
    expect(getPendingApproval('conf-2')?.status).toBe('submitted');
  });

  it('expires stale pending approvals', () => {
    const now = Date.now();
    savePendingApproval({
      approvalId: 'conf-old',
      peerId: 'peer-3',
      requestId: 'req-3',
      agentId: 'agent-c',
      taskId: 'task-3',
      prompt: 'old',
      actions: [],
      status: 'pending',
      createdAt: now - 100_000,
      expiresAt: now - 1,
    });
    expireStalePendingApprovals();
    expect(getPendingApproval('conf-old')?.status).toBe('expired');
  });
});
