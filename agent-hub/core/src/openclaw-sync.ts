/**
 * Hub-side OpenClaw CLI session sync (manual only — triggered from dashboard).
 */

import {
  previewOpenclawSync,
  runOpenclawSync,
  type OpenclawSyncPreview,
  type OpenclawSyncResult,
} from 'shepaw-acp-proxy-gateway';

import { getInstance, loadOrCreateHubConfig, InstanceNotFoundError } from './config.js';
import { instancePaths } from './paths.js';

export type { OpenclawSyncPreview, OpenclawSyncResult };

export class OpenclawSyncNotSupportedError extends Error {
  constructor(engine: string) {
    super(`OpenClaw CLI sync is only available for engine "openclaw" (got "${engine}").`);
    this.name = 'OpenclawSyncNotSupportedError';
  }
}

function requireOpenclawInstance(instanceId: string) {
  const cfg = loadOrCreateHubConfig();
  const instance = getInstance(cfg, instanceId);
  if (instance.engine !== 'openclaw') {
    throw new OpenclawSyncNotSupportedError(instance.engine);
  }
  return instance;
}

export async function previewInstanceOpenclawSync(
  instanceId: string,
): Promise<OpenclawSyncPreview> {
  const instance = requireOpenclawInstance(instanceId);
  const paths = instancePaths(instanceId);
  return previewOpenclawSync({
    cwd: instance.cwd,
    syncPath: paths.openclawSyncPath,
    sessionStorePath: paths.sessionsPath,
  });
}

export async function syncInstanceOpenclawSessions(
  instanceId: string,
  opts: { sessionIds?: readonly string[] } = {},
): Promise<OpenclawSyncResult> {
  const instance = requireOpenclawInstance(instanceId);
  const paths = instancePaths(instanceId);
  return runOpenclawSync({
    cwd: instance.cwd,
    syncPath: paths.openclawSyncPath,
    sessionIds: opts.sessionIds,
    sessionStorePath: paths.sessionsPath,
  });
}

export { InstanceNotFoundError };
