/**
 * Hub-side Codex CLI session sync (manual only — triggered from dashboard).
 */

import {
  previewCodexSync,
  runCodexSync,
  type CodexSyncPreview,
  type CodexSyncResult,
} from 'shepaw-acp-proxy-gateway';

import { getInstance, loadOrCreateHubConfig, InstanceNotFoundError } from './config.js';
import { instancePaths } from './paths.js';

export type { CodexSyncPreview, CodexSyncResult };

export class CodexSyncNotSupportedError extends Error {
  constructor(engine: string) {
    super(`Codex CLI sync is only available for engine "codex" (got "${engine}").`);
    this.name = 'CodexSyncNotSupportedError';
  }
}

function requireCodexInstance(instanceId: string) {
  const cfg = loadOrCreateHubConfig();
  const instance = getInstance(cfg, instanceId);
  if (instance.engine !== 'codex') {
    throw new CodexSyncNotSupportedError(instance.engine);
  }
  return instance;
}

export async function previewInstanceCodexSync(instanceId: string): Promise<CodexSyncPreview> {
  const instance = requireCodexInstance(instanceId);
  const paths = instancePaths(instanceId);
  return previewCodexSync({ cwd: instance.cwd, syncPath: paths.codexSyncPath });
}

export async function syncInstanceCodexSessions(
  instanceId: string,
  opts: { sessionIds?: readonly string[] } = {},
): Promise<CodexSyncResult> {
  const instance = requireCodexInstance(instanceId);
  const paths = instancePaths(instanceId);
  return runCodexSync({
    cwd: instance.cwd,
    syncPath: paths.codexSyncPath,
    sessionIds: opts.sessionIds,
  });
}

export { InstanceNotFoundError };
