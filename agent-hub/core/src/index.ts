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
  DEFAULT_ROUTER_HOST,
  DEFAULT_ROUTER_PORT,
  deleteProjectEnvVar,
  findProject,
  getProject,
  loadOrCreateHubConfig,
  ProjectExistsError,
  ProjectNotFoundError,
  removeCustomEngineFromHub,
  removeProject,
  resolveApprovalPolicy,
  saveHubConfig,
  setHubGateway,
  setProjectEnvVar,
  updateHubMeta,
  updateProject,
} from './config.js';
export type { AgentEngine, ApprovalMode, ApprovalPolicyConfig, CredentialHint, GatewayConfig, HubConfig, HubCredentialCache, LoadHubOptions, ProjectConfig, TunnelConfig } from './config.js';

export { decryptEnvVars, encryptEnvVars, encryptValue, decryptValue } from './crypto.js';

export { detectLanIPv4, resolvePublicHost } from './network.js';

export {
  gatewayLogFile,
  gatewayLogsDir,
  gatewayStatePath,
  hubConfigPath,
  hubEnrollmentsPath,
  hubRoot,
  normalizeCwd,
  projectPaths,
  validateProjectId,
} from './paths.js';
export type { ProjectPaths } from './paths.js';

export { GatewayTunnelRouter } from './tunnel-router.js';
export type { GatewayRouterOptions } from './tunnel-router.js';

export {
  isGatewayRunning,
  readGatewayState,
  startGatewayRouter,
  stopGatewayRouter,
} from './gateway-process.js';
export type { GatewayState } from './gateway-process.js';

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
  createHubPairing,
  ensureHubPairingDir,
  fanOutHubPeer,
  hubFanoutEnvPaths,
  listHubAgentCatalog,
  listHubEnrollments,
  listHubPairedDevices,
  removeHubPairedDevice,
  revokeHubEnrollment,
} from './pairing.js';
export type {
  CreateHubPairingOptions,
  FanOutPeerOptions,
  HubAgentCatalogEntry,
  HubPairedDevice,
  HubPairingResult,
} from './pairing.js';
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
