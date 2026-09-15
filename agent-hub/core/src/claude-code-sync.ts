/**
 * Hub-side Claude Code CLI session sync (manual only — triggered from dashboard).
 */

import {
  previewClaudeCodeSync,
  runClaudeCodeSync,
  type ClaudeCodeSyncPreview,
  type ClaudeCodeSyncResult,
} from 'shepaw-acp-proxy-gateway';

import { getInstance, loadOrCreateHubConfig, InstanceNotFoundError } from './config.js';
import { instancePaths } from './paths.js';

export type { ClaudeCodeSyncPreview, ClaudeCodeSyncResult };

export class ClaudeCodeSyncNotSupportedError extends Error {
  constructor(engine: string) {
    super(`Claude Code CLI sync is only available for engine "claude-code" (got "${engine}").`);
    this.name = 'ClaudeCodeSyncNotSupportedError';
  }
}

function requireClaudeCodeInstance(instanceId: string) {
  const cfg = loadOrCreateHubConfig();
  const instance = getInstance(cfg, instanceId);
  if (instance.engine !== 'claude-code') {
    throw new ClaudeCodeSyncNotSupportedError(instance.engine);
  }
  return instance;
}

export async function previewInstanceClaudeCodeSync(
  instanceId: string,
): Promise<ClaudeCodeSyncPreview> {
  const instance = requireClaudeCodeInstance(instanceId);
  const paths = instancePaths(instanceId);
  return previewClaudeCodeSync({ cwd: instance.cwd, syncPath: paths.claudeCodeSyncPath });
}

export async function syncInstanceClaudeCodeSessions(
  instanceId: string,
  opts: { sessionIds?: readonly string[] } = {},
): Promise<ClaudeCodeSyncResult> {
  const instance = requireClaudeCodeInstance(instanceId);
  const paths = instancePaths(instanceId);
  return runClaudeCodeSync({
    cwd: instance.cwd,
    syncPath: paths.claudeCodeSyncPath,
    sessionIds: opts.sessionIds,
  });
}

export { InstanceNotFoundError };
