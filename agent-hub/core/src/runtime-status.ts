/**
 * Live runtime probes against gateway HTTP /status (with /health fallback).
 *
 * Complements PID-based checks in spawn.ts: a process can be alive but hung,
 * or listening while the upstream ACP agent is still starting.
 */

import type { AgentBusyLevel, AgentRuntimeStatus } from 'shepaw-acp-sdk';

import type { ProjectConfig } from './config.js';
import { isAlive, readState } from './spawn.js';
import { projectPaths } from './paths.js';

/** How reachable / healthy the gateway is from Hub's perspective. */
export type AgentAvailability = 'offline' | 'starting' | 'online' | 'degraded';

export interface ProjectProcessStatus {
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  stoppedAt: string | null;
  lastResult: 'graceful' | 'hard' | 'crashed' | null;
}

export interface ProjectRuntimeStatus extends ProjectProcessStatus {
  availability: AgentAvailability;
  busyLevel: AgentBusyLevel | null;
  activeTasks: number | null;
  connectedClients: number | null;
  acpConnected: boolean | null;
  acpSessionCount: number | null;
  hasActiveTurn: boolean | null;
  uptimeMs: number | null;
  probedAt: string;
  probeError: string | null;
}

const DEFAULT_PROBE_TIMEOUT_MS = 1_500;
/** Upstream ACP init grace window before we call a live gateway "degraded". */
const STARTING_GRACE_MS = 30_000;

export interface ProbeProjectRuntimeOptions {
  timeoutMs?: number;
}

function readProcessStatus(projectId: string): ProjectProcessStatus {
  const paths = projectPaths(projectId);
  const state = readState(paths.statePath);
  const running = state !== undefined && state.pid > 0 && isAlive(state.pid);
  return {
    running,
    pid: running ? state!.pid : null,
    startedAt: state?.startedAt ?? null,
    stoppedAt: state?.stoppedAt ?? null,
    lastResult: state?.lastResult ?? null,
  };
}

function parseRuntimePayload(raw: unknown): AgentRuntimeStatus | undefined {
  if (raw === undefined || raw === null || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const activeTasks = typeof obj.activeTasks === 'number' ? obj.activeTasks : undefined;
  const connectedClients = typeof obj.connectedClients === 'number' ? obj.connectedClients : undefined;
  const uptimeMs = typeof obj.uptimeMs === 'number' ? obj.uptimeMs : undefined;
  const busyLevel =
    obj.busyLevel === 'idle' || obj.busyLevel === 'busy' || obj.busyLevel === 'overloaded'
      ? obj.busyLevel
      : undefined;
  if (
    activeTasks === undefined ||
    connectedClients === undefined ||
    uptimeMs === undefined ||
    busyLevel === undefined
  ) {
    return undefined;
  }
  const status: AgentRuntimeStatus = {
    activeTasks,
    connectedClients,
    uptimeMs,
    busyLevel,
  };
  if (typeof obj.acpConnected === 'boolean') status.acpConnected = obj.acpConnected;
  if (typeof obj.acpSessionCount === 'number') status.acpSessionCount = obj.acpSessionCount;
  if (typeof obj.hasActiveTurn === 'boolean') status.hasActiveTurn = obj.hasActiveTurn;
  return status;
}

function deriveAvailability(
  process: ProjectProcessStatus,
  runtime: AgentRuntimeStatus | undefined,
  probeError: string | null,
): AgentAvailability {
  if (!process.running) return 'offline';
  if (probeError !== null) return 'degraded';

  if (runtime?.acpConnected === false) {
    return runtime.uptimeMs < STARTING_GRACE_MS ? 'starting' : 'degraded';
  }

  return 'online';
}

async function fetchGatewayStatus(
  project: ProjectConfig,
  timeoutMs: number,
): Promise<{ runtime?: AgentRuntimeStatus; probeError: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const base = `http://${project.host}:${project.port}`;

  try {
    let res = await fetch(`${base}/status`, { signal: controller.signal });
    if (res.status === 404) {
      res = await fetch(`${base}/health`, { signal: controller.signal });
    }
    if (!res.ok) {
      return { probeError: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as Record<string, unknown>;
    if (body.status !== 'ok') {
      return { probeError: 'unexpected response status' };
    }
    return {
      runtime: parseRuntimePayload(body.runtime),
      probeError: null,
    };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.name === 'AbortError'
          ? 'probe timed out'
          : err.message
        : String(err);
    return { probeError: message };
  } finally {
    clearTimeout(timer);
  }
}

/** Merge PID state with a live HTTP probe against the gateway. */
export async function probeProjectRuntime(
  project: ProjectConfig,
  opts: ProbeProjectRuntimeOptions = {},
): Promise<ProjectRuntimeStatus> {
  const process = readProcessStatus(project.id);
  const probedAt = new Date().toISOString();

  if (!process.running) {
    return {
      ...process,
      availability: 'offline',
      busyLevel: null,
      activeTasks: null,
      connectedClients: null,
      acpConnected: null,
      acpSessionCount: null,
      hasActiveTurn: null,
      uptimeMs: null,
      probedAt,
      probeError: null,
    };
  }

  const { runtime, probeError } = await fetchGatewayStatus(
    project,
    opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
  );

  return {
    ...process,
    availability: deriveAvailability(process, runtime, probeError),
    busyLevel: runtime?.busyLevel ?? null,
    activeTasks: runtime?.activeTasks ?? null,
    connectedClients: runtime?.connectedClients ?? null,
    acpConnected: runtime?.acpConnected ?? null,
    acpSessionCount: runtime?.acpSessionCount ?? null,
    hasActiveTurn: runtime?.hasActiveTurn ?? null,
    uptimeMs: runtime?.uptimeMs ?? null,
    probedAt,
    probeError,
  };
}

/** PID-only status (no HTTP probe) — useful for fast CLI paths. */
export function readProjectProcessStatus(projectId: string): ProjectProcessStatus {
  return readProcessStatus(projectId);
}
