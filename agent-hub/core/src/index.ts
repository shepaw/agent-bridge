/**
 * Programmatic API for shepaw-agent-hub.
 *
 * The CLI is the primary surface, but the pieces are also exposed here so
 * operators who want to build their own tooling (e.g. a GUI supervisor or
 * a CI script that spins up ephemeral projects) can.
 */

export {
  addProject,
  addCustomEngineToHub,
  deleteProjectEnvVar,
  findProject,
  getProject,
  loadOrCreateHubConfig,
  ProjectExistsError,
  ProjectNotFoundError,
  removeCustomEngineFromHub,
  removeProject,
  saveHubConfig,
  setProjectEnvVar,
  updateHubMeta,
  updateProject,
} from './config.js';
export type { AgentEngine, CredentialHint, HubConfig, HubCredentialCache, LoadHubOptions, ProjectConfig, TunnelConfig } from './config.js';

export { decryptEnvVars, encryptEnvVars, encryptValue, decryptValue } from './crypto.js';

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

export {
  probeProjectRuntime,
  readProjectProcessStatus,
} from './runtime-status.js';
export type {
  AgentAvailability,
  ProbeProjectRuntimeOptions,
  ProjectProcessStatus,
  ProjectRuntimeStatus,
} from './runtime-status.js';
export { deleteProjectSession, listProjectSessions } from './sessions.js';
export type { ProjectSessionEntry } from './sessions.js';

export {
  BUILTIN_ENGINE_IDS,
  BUILTIN_ENGINE_LABELS,
  CustomEngineExistsError,
  CustomEngineInUseError,
  CustomEngineNotFoundError,
  findCustomEngine,
  formatShellCommand,
  isBuiltinEngine,
  isKnownEngine,
  listEngineInfos,
  parseShellCommand,
  validateCustomEngineId,
} from './engines.js';
export type { BuiltinAgentEngine, CustomEngineDefinition, EngineInfo } from './engines.js';
