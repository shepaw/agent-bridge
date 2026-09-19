/**
 * Hub-side Cursor IDE session sync (manual only — triggered from dashboard).
 */

import {
  previewCursorIdeSync,
  runCursorIdeSync,
  type CursorIdeSyncPreview,
  type CursorIdeSyncResult,
} from 'shepaw-acp-proxy-gateway';

import { getInstance, loadOrCreateHubConfig, InstanceNotFoundError } from './config.js';
import { instancePaths } from './paths.js';

export type { CursorIdeSyncPreview, CursorIdeSyncResult };

export class CursorIdeSyncNotSupportedError extends Error {
  constructor(engine: string) {
    super(`Cursor IDE sync is only available for engine "cursor" (got "${engine}").`);
    this.name = 'CursorIdeSyncNotSupportedError';
  }
}

function requireCursorInstance(instanceId: string) {
  const cfg = loadOrCreateHubConfig();
  const instance = getInstance(cfg, instanceId);
  if (instance.engine !== 'cursor') {
    throw new CursorIdeSyncNotSupportedError(instance.engine);
  }
  return instance;
}

export async function previewInstanceCursorIdeSync(
  instanceId: string,
): Promise<CursorIdeSyncPreview> {
  const instance = requireCursorInstance(instanceId);
  const paths = instancePaths(instanceId);
  return previewCursorIdeSync({
    cwd: instance.cwd,
    syncPath: paths.cursorIdeSyncPath,
    sessionStorePath: paths.sessionsPath,
  });
}

export async function syncInstanceCursorIdeSessions(
  instanceId: string,
  opts: { sessionIds?: readonly string[] } = {},
): Promise<CursorIdeSyncResult> {
  const instance = requireCursorInstance(instanceId);
  const paths = instancePaths(instanceId);
  return runCursorIdeSync({
    cwd: instance.cwd,
    syncPath: paths.cursorIdeSyncPath,
    sessionIds: opts.sessionIds,
    sessionStorePath: paths.sessionsPath,
  });
}

export { InstanceNotFoundError };
