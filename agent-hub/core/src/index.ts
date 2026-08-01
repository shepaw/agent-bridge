/**
 * Programmatic API for shepaw-agent-hub.
 *
 * The CLI is the primary surface, but the pieces are also exposed here so
 * operators who want to build their own tooling (e.g. a GUI supervisor or
 * a CI script that spins up ephemeral instances) can.
 */

export {
  addInstance,
  addCustomEngineToHub,
  clearEngineApproval,
  DEFAULT_ROUTER_HOST,
  DEFAULT_ROUTER_PORT,
  deleteEngineEnvVar,
  deleteInstanceEnvVar,
  engineEnvVarKeys,
  findInstance,
  getInstance,
  isEngineDisabled,
  isKnownEngineForOverrides,
  loadOrCreateHubConfig,
  InstanceExistsError,
  InstanceNotFoundError,
  removeCustomEngineFromHub,
  removeInstance,
  resolveApprovalPolicy,
  resolveEngineEnvVars,
  saveHubConfig,
  setEngineEnvVar,
  setEngineOverride,
  setHubGateway,
  setInstanceEnvVar,
  updateCustomEngineInHub,
  updateHubMeta,
  updateInstance,
} from './config.js';
export type {
  AgentEngine,
  ApprovalMode,
  ApprovalPolicyConfig,
  CredentialHint,
  EngineOverrides,
  EngineOverridesMap,
  GatewayConfig,
  HubConfig,
  HubCredentialCache,
  LoadHubOptions,
  InstanceConfig,
  PeerServiceConfig,
  TunnelConfig,
} from './config.js';
export { DEFAULT_PEER_HOST, DEFAULT_PEER_PORT } from './config.js';

// ── peer service (shepaw://peer responder + agent-host proxy) ──────
export {
  isPeerServiceRunning,
  mintPairingQr,
  peerServiceStatus,
  startPeerService,
  stopPeerService,
} from './peer/peer-process.js';
export { loadOrCreatePeerIdentity } from './peer/peer-identity.js';
export {
  authorizePeerServiceOnAllInstances,
  authorizePeerServiceOnInstance,
  PEER_SERVICE_PEER_LABEL,
} from './peer/peer-auth.js';
export type { MintPairingResult } from './peer/peer-process.js';
export { loadPairedPeers, removePairedPeer, type PairedPeer } from './peer/peer-store.js';
export { listAgents } from './peer/peer-agent-host.js';
export { PeerAcpClient } from './peer/peer-acp-client.js';
export {
  assertSafeAttachmentName,
  clearPeerAttachments,
  deletePeerAttachment,
  listPeerAttachments,
  MAX_PEER_FILE_BYTES,
  normalizePeerAttachmentRefs,
  persistIncomingFile,
  resolveAttachmentsForAcp,
  safeFileName,
  type IncomingPeerFile,
  type PeerAttachmentInfo,
  type StoredPeerFile,
} from './peer/peer-file-store.js';

export { decryptEnvVars, encryptEnvVars, encryptValue, decryptValue } from './crypto.js';
export { isSensitiveEnvVarKey } from './env-var-sensitivity.js';

export { detectLanIPv4, resolvePublicHost } from './network.js';

export {
  gatewayLogFile,
  gatewayLogsDir,
  gatewayStatePath,
  hubConfigPath,
  hubEnrollmentsPath,
  hubRoot,
  normalizeCwd,
  instancePaths,
  peerAttachmentsDir,
  validateInstanceId,
} from './paths.js';
export type { InstancePaths } from './paths.js';

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
  ensureInstanceDir,
  isAlive,
  readState,
  restartAllInstances,
  restartInstance,
  rotateInstanceLogs,
  startInstance,
  stopInstance,
  writeState,
} from './spawn.js';
export type { InstanceState, RestartInstanceResult, StopResult } from './spawn.js';

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
  probeInstanceRuntime,
  readInstanceProcessStatus,
} from './runtime-status.js';
export type {
  AgentAvailability,
  ProbeInstanceRuntimeOptions,
  InstanceProcessStatus,
  InstanceRuntimeStatus,
} from './runtime-status.js';
export { deleteInstanceSession, listInstanceSessions } from './sessions.js';
export type { InstanceSessionEntry } from './sessions.js';

export {
  closeInstanceAcpRpcClient,
  getInstanceConversationHistory,
  InstanceGatewayOfflineError,
  listInstanceConversations,
} from './instance-acp-rpc.js';

export {
  BUILTIN_ENGINE_ACP_COMMANDS,
  augmentSpawnPath,
  resolveCursorCliBinary,
  getCursorAcpCommand,
  checkCustomEngineInstallStatus,
  probeCursorApiKey,
  isHealthyCursorCli,
  checkCursorInstallStatus,
  checkEngineInstallStatus,
  clearEngineProbeCaches,
  enrichEngineInfo,
  detectHubPlatform,
  hubPlatformLabel,
  spawnPathPrefixes,
  getEngineSetupGuide,
  resolveBinaryPath,
  resolveEngineAvailability,
  runEngineInstall,
} from './engine-setup.js';
export type {
  EngineAvailability,
  EngineEnvVarHint,
  EngineInstallResult,
  EngineInstallStatus,
  EngineSetupGuide,
  EngineSetupStep,
  HubPlatform,
} from './engine-setup.js';

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
export type { BuiltinAgentEngine, CustomEngineDefinition, EngineInfo, EngineOverrideInstanceion } from './engines.js';
export {
  BUILTIN_ENGINE_AVATARS,
  GENERIC_DEFAULT_AVATAR,
  defaultAvatarForEngine,
  engineAvatarMarker,
  listBundledEngineAvatarIds,
  loadEngineAvatarPayload,
  resolveEngineAvatarFile,
} from './engine-avatars.js';
export type { EngineAvatarPayload } from './engine-avatars.js';
