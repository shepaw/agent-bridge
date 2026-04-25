/**
 * Programmatic API for shepaw-agent-hub.
 *
 * The CLI is the primary surface, but the pieces are also exposed here so
 * operators who want to build their own tooling (e.g. a GUI supervisor or
 * a CI script that spins up ephemeral projects) can.
 */

export {
  addProject,
  findProject,
  getProject,
  loadOrCreateHubConfig,
  ProjectExistsError,
  ProjectNotFoundError,
  removeProject,
  saveHubConfig,
  updateProject,
} from './config.js';
export type { AgentEngine, HubConfig, ProjectConfig, LoadHubOptions } from './config.js';

export {
  hubConfigPath,
  hubRoot,
  normalizeCwd,
  projectPaths,
  validateProjectId,
} from './paths.js';
export type { ProjectPaths } from './paths.js';

export { nextFreePort, NoFreePortError, probeBindable } from './ports.js';
export type { FindPortOptions } from './ports.js';

export {
  ensureProjectDir,
  isAlive,
  readState,
  rotateProjectLogs,
  startProject,
  stopProject,
  writeState,
} from './spawn.js';
export type { ProjectState, StopResult } from './spawn.js';

export { tailLog } from './logs.js';
export type { TailOptions } from './logs.js';
