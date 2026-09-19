/**
 * Hub-side OpenCode CLI session sync (manual only — triggered from dashboard).
 */

import {
  previewOpencodeSync,
  runOpencodeSync,
  type OpencodeSyncPreview,
  type OpencodeSyncResult,
} from 'shepaw-acp-proxy-gateway';

import { getInstance, loadOrCreateHubConfig, InstanceNotFoundError } from './config.js';
import { instancePaths } from './paths.js';

export type { OpencodeSyncPreview, OpencodeSyncResult };

export class OpencodeSyncNotSupportedError extends Error {
  constructor(engine: string) {
    super(`OpenCode CLI sync is only available for engine "opencode" (got "${engine}").`);
    this.name = 'OpencodeSyncNotSupportedError';
  }
}

function requireOpencodeInstance(instanceId: string) {
  const cfg = loadOrCreateHubConfig();
  const instance = getInstance(cfg, instanceId);
  if (instance.engine !== 'opencode') {
    throw new OpencodeSyncNotSupportedError(instance.engine);
  }
  return instance;
}

export async function previewInstanceOpencodeSync(
  instanceId: string,
): Promise<OpencodeSyncPreview> {
  const instance = requireOpencodeInstance(instanceId);
  const paths = instancePaths(instanceId);
  return previewOpencodeSync({
    cwd: instance.cwd,
    syncPath: paths.opencodeSyncPath,
    sessionStorePath: paths.sessionsPath,
  });
}

export async function syncInstanceOpencodeSessions(
  instanceId: string,
  opts: { sessionIds?: readonly string[] } = {},
): Promise<OpencodeSyncResult> {
  const instance = requireOpencodeInstance(instanceId);
  const paths = instancePaths(instanceId);
  return runOpencodeSync({
    cwd: instance.cwd,
    syncPath: paths.opencodeSyncPath,
    sessionIds: opts.sessionIds,
    sessionStorePath: paths.sessionsPath,
  });
}

export { InstanceNotFoundError };
