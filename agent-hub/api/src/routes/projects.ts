/**
 * Projects REST routes.
 *
 * GET    /api/projects               — list all projects with live status
 * POST   /api/projects               — register a new project
 * GET    /api/projects/:id           — get one project + state
 * DELETE /api/projects/:id           — unregister (stops first if running)
 * PATCH  /api/projects/:id           — update label/host/cwd/baseUrl/extraArgs
 * POST   /api/projects/:id/start     — start the gateway process
 * POST   /api/projects/:id/stop      — stop the gateway process
 * GET    /api/projects/:id/peers     — list authorized peers
 * POST   /api/projects/:id/peers     — add a peer { pubkey, label? }
 * DELETE /api/projects/:id/peers/:fp — remove a peer by fingerprint
 * POST   /api/projects/:id/enroll    — mint a new pairing code { label?, ttlMinutes? }
 * GET    /api/projects/:id/enroll    — list outstanding pairing codes
 * DELETE /api/projects/:id/enroll/:code — revoke a pairing code
 * GET    /api/projects/:id/envvars   — list env var keys (values masked)
 * PUT    /api/projects/:id/envvars/:key — set a single env var
 * DELETE /api/projects/:id/envvars/:key — delete a single env var
 */

import { Router, type Request, type Response } from 'express';
import {
  addPeer,
  createEnrollmentToken,
  formatCodeForDisplay,
  loadOrCreateEnrollments,
  loadOrCreateIdentity,
  loadOrCreatePeers,
  removePeerByFingerprint,
  revokeEnrollmentToken,
} from 'shepaw-acp-sdk';
import {
  addProject,
  deleteProjectEnvVar,
  ensureProjectDir,
  getProject,
  isAlive,
  loadOrCreateHubConfig,
  nextFreePort,
  projectPaths,
  ProjectExistsError,
  ProjectNotFoundError,
  readState,
  removeProject,
  setProjectEnvVar,
  startProject,
  stopProject,
  updateProject,
  type AgentEngine,
  type ProjectConfig,
  type TunnelConfig,
} from '@shepaw/agent-hub-core';

export const projectsRouter = Router();

// ── helpers ────────────────────────────────────────────────────────

function projectStatus(id: string) {
  const paths = projectPaths(id);
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

function enrichProject(p: ProjectConfig) {
  return {
    ...p,
    // Never expose encrypted envVar values — only the key names.
    envVars: undefined,
    envVarKeys: Object.keys(p.envVars ?? {}),
    status: projectStatus(p.id),
  };
}

function parseEngine(raw: unknown): AgentEngine {
  if (raw === 'codebuddy' || raw === 'claude-code' || raw === 'codex' || raw === 'opencode') return raw;
  throw new Error(`Invalid engine "${String(raw)}". Expected "codebuddy", "claude-code", "codex", or "opencode".`);
}

/**
 * Parse a tunnel object from a request body. Returns undefined if the input
 * is not a valid tunnel config (all three fields required).
 */
function parseTunnelBody(v: unknown): TunnelConfig | undefined {
  if (v === undefined || v === null || typeof v !== 'object') return undefined;
  const obj = v as Record<string, unknown>;
  if (typeof obj.serverUrl !== 'string' || obj.serverUrl.length === 0) return undefined;
  if (typeof obj.channelId !== 'string' || obj.channelId.length === 0) return undefined;
  if (typeof obj.secret !== 'string' || obj.secret.length === 0) return undefined;
  return { serverUrl: obj.serverUrl, channelId: obj.channelId, secret: obj.secret };
}

// ── list all ───────────────────────────────────────────────────────

projectsRouter.get('/', (_req: Request, res: Response) => {
  const cfg = loadOrCreateHubConfig();
  res.json(cfg.projects.map(enrichProject));
});

// ── create ─────────────────────────────────────────────────────────

projectsRouter.post('/', async (req: Request, res: Response) => {
  try {
    const { id, engine, cwd, label, port, host, baseUrl, extraArgs, tunnel, envVars } = req.body as Record<string, unknown>;
    if (typeof id !== 'string' || id.length === 0) {
      res.status(400).json({ error: 'id is required' });
      return;
    }
    const cfg = loadOrCreateHubConfig();
    const resolvedEngine = parseEngine(engine ?? 'codebuddy');
    const reservedPorts = cfg.projects.map((p) => p.port);
    const resolvedPort = typeof port === 'number' ? port : await nextFreePort({ reserved: reservedPorts });

    const resolvedTunnel = parseTunnelBody(tunnel);
    // Auto-derive baseUrl from tunnel if not explicitly provided
    const resolvedBaseUrl = typeof baseUrl === 'string'
      ? baseUrl
      : resolvedTunnel
        ? `${resolvedTunnel.serverUrl}/proxy/${resolvedTunnel.channelId}`
        : '';

    const project: Omit<ProjectConfig, 'envVars'> & { plainEnvVars?: Record<string, string> } = {
      id,
      label: typeof label === 'string' ? label : id,
      engine: resolvedEngine,
      cwd: typeof cwd === 'string' ? cwd : process.cwd(),
      port: resolvedPort,
      host: typeof host === 'string' ? host : '127.0.0.1',
      baseUrl: resolvedBaseUrl,
      extraArgs: Array.isArray(extraArgs) ? extraArgs.filter((x): x is string => typeof x === 'string') : [],
      createdAt: new Date().toISOString(),
      tunnel: resolvedTunnel,
      plainEnvVars: (envVars !== undefined && typeof envVars === 'object' && !Array.isArray(envVars))
        ? Object.fromEntries(
            Object.entries(envVars as Record<string, unknown>)
              .filter(([ , v]) => typeof v === 'string')
              .map(([k, v]) => [k, v as string]),
          )
        : undefined,
    };

    const { id: _id, label: _label, engine: _engine, cwd: _cwd, port: _port, host: _host,
      baseUrl: _baseUrl, extraArgs: _extraArgs, createdAt: _createdAt, tunnel: _tunnel } = req.body as Record<string, unknown>;

    addProject(cfg, project);
    ensureProjectDir(id);
    const savedCfg = loadOrCreateHubConfig();
    const saved = savedCfg.projects.find((p) => p.id === id) ?? project as unknown as ProjectConfig;
    res.status(201).json(enrichProject(saved));
  } catch (err) {
    if (err instanceof ProjectExistsError) {
      res.status(409).json({ error: err.message });
    } else {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
});

// ── get one ────────────────────────────────────────────────────────

projectsRouter.get('/:id', (req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    const p = getProject(cfg, req.params.id!);
    res.json(enrichProject(p));
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: String(err) });
    }
  }
});

// ── delete ─────────────────────────────────────────────────────────

projectsRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    const p = getProject(cfg, req.params.id!);
    const paths = projectPaths(p.id);
    const state = readState(paths.statePath);
    if (state !== undefined && state.pid > 0 && isAlive(state.pid)) {
      await stopProject(p);
    }
    removeProject(cfg, p.id);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: String(err) });
    }
  }
});

// ── patch ──────────────────────────────────────────────────────────

projectsRouter.patch('/:id', (req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    getProject(cfg, req.params.id!);
    const { label, host, baseUrl, cwd, extraArgs, tunnel, clearTunnel, envVars, clearEnvVars } = req.body as Record<string, unknown>;
    const patch: Parameters<typeof updateProject>[2] = {};
    if (typeof label === 'string') patch.label = label;
    if (typeof host === 'string') patch.host = host;
    if (typeof cwd === 'string') patch.cwd = cwd;
    if (Array.isArray(extraArgs)) patch.extraArgs = extraArgs.filter((x): x is string => typeof x === 'string');
    if (clearTunnel === true) {
      (patch as Record<string, unknown>).tunnel = undefined;
    } else if (tunnel !== undefined) {
      const resolvedTunnel = parseTunnelBody(tunnel);
      if (resolvedTunnel !== undefined) {
        patch.tunnel = resolvedTunnel;
        if (typeof baseUrl !== 'string') {
          patch.baseUrl = `${resolvedTunnel.serverUrl}/proxy/${resolvedTunnel.channelId}`;
        }
      }
    }
    if (typeof baseUrl === 'string') patch.baseUrl = baseUrl;
    if (clearEnvVars === true) patch.clearEnvVars = true;
    if (envVars !== undefined && typeof envVars === 'object' && !Array.isArray(envVars)) {
      patch.mergeEnvVars = Object.fromEntries(
        Object.entries(envVars as Record<string, unknown>)
          .filter(([, v]) => typeof v === 'string')
          .map(([k, v]) => [k, v as string]),
      );
    }
    const next = updateProject(cfg, req.params.id!, patch);
    const updated = next.projects.find((p) => p.id === req.params.id)!;
    res.json(enrichProject(updated));
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(400).json({ error: String(err) });
    }
  }
});

// ── start ──────────────────────────────────────────────────────────

projectsRouter.post('/:id/start', async (req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    const p = getProject(cfg, req.params.id!);
    ensureProjectDir(p.id);
    const result = await startProject(p);
    res.json({ pid: result.pid, alreadyRunning: result.alreadyRunning });
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
});

// ── stop ───────────────────────────────────────────────────────────

projectsRouter.post('/:id/stop', async (req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    const p = getProject(cfg, req.params.id!);
    const result = await stopProject(p);
    res.json({ result });
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: String(err) });
    }
  }
});

// ── envvars ────────────────────────────────────────────────────────

/** GET /api/projects/:id/envvars — list key names only, values masked */
projectsRouter.get('/:id/envvars', (req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    const p = getProject(cfg, req.params.id!);
    const keys = Object.keys(p.envVars ?? {});
    res.json(keys.map((key) => ({ key, value: '(masked)' })));
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: String(err) });
    }
  }
});

/** PUT /api/projects/:id/envvars/:key — set (or replace) a single env var */
projectsRouter.put('/:id/envvars/:key', (req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    getProject(cfg, req.params.id!);
    const { value } = req.body as Record<string, unknown>;
    if (typeof value !== 'string') {
      res.status(400).json({ error: '"value" must be a string' });
      return;
    }
    setProjectEnvVar(cfg, req.params.id!, req.params.key!, value);
    res.json({ ok: true, key: req.params.key });
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(400).json({ error: String(err) });
    }
  }
});

/** DELETE /api/projects/:id/envvars/:key — remove a single env var */
projectsRouter.delete('/:id/envvars/:key', (req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    getProject(cfg, req.params.id!);
    deleteProjectEnvVar(cfg, req.params.id!, req.params.key!);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: String(err) });
    }
  }
});

// ── peers ──────────────────────────────────────────────────────────

projectsRouter.get('/:id/peers', (req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    getProject(cfg, req.params.id!);
    const paths = projectPaths(req.params.id!);
    const peers = loadOrCreatePeers({ path: paths.peersPath });
    res.json(peers.peers);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: String(err) });
    }
  }
});

projectsRouter.post('/:id/peers', (req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    getProject(cfg, req.params.id!);
    const { pubkey, label } = req.body as Record<string, unknown>;
    if (typeof pubkey !== 'string' || pubkey.length === 0) {
      res.status(400).json({ error: 'pubkey is required' });
      return;
    }
    const paths = projectPaths(req.params.id!);
    const entry = addPeer(paths.peersPath, pubkey, typeof label === 'string' ? label : undefined);
    res.status(201).json(entry);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(400).json({ error: String(err) });
    }
  }
});

projectsRouter.delete('/:id/peers/:fp', (req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    getProject(cfg, req.params.id!);
    const paths = projectPaths(req.params.id!);
    const removed = removePeerByFingerprint(paths.peersPath, req.params.fp!);
    if (removed) {
      res.json({ ok: true });
    } else {
      res.status(404).json({ error: `No peer with fingerprint ${req.params.fp}` });
    }
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: String(err) });
    }
  }
});

// ── enrollment ─────────────────────────────────────────────────────

projectsRouter.get('/:id/enroll', (req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    getProject(cfg, req.params.id!);
    const paths = projectPaths(req.params.id!);
    const store = loadOrCreateEnrollments({ path: paths.enrollmentsPath });
    res.json(store.tokens.map((t) => ({ ...t, display: formatCodeForDisplay(t.code) })));
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: String(err) });
    }
  }
});

projectsRouter.post('/:id/enroll', (req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    const p = getProject(cfg, req.params.id!);
    const paths = projectPaths(req.params.id!);
    ensureProjectDir(req.params.id!);

    const { label, ttlMinutes, baseUrl } = req.body as Record<string, unknown>;
    const ttlMs = Math.max(1, Math.floor(Number(ttlMinutes ?? 10))) * 60 * 1000;

    const identity = loadOrCreateIdentity({ path: paths.identityPath });
    const token = createEnrollmentToken(paths.enrollmentsPath, {
      label: typeof label === 'string' ? label : 'dashboard-paired device',
      ttlMs,
    });

    // The Noise IK initiator (app) needs the responder's full 32-byte static
    // public key upfront to encrypt hs1. Include it as pk= in the fragment so
    // the app can pin the correct key. encodeURIComponent is needed because
    // base64 can contain +, /, = which are reserved in URI fragments.
    const pkB64 = Buffer.from(identity.staticPublicKey).toString('base64');
    const pkEncoded = encodeURIComponent(pkB64);
    const fragmentParams = `fp=${identity.fingerprint}&pk=${pkEncoded}`;

    const base = (typeof baseUrl === 'string' ? baseUrl : '') || p.baseUrl;
    let pairUrl: string;
    if (base) {
      const clean = base.replace(/\/$/, '');
      pairUrl = `${clean}/acp/ws?agentId=${identity.agentId}#${fragmentParams}`;
    } else {
      pairUrl = `ws://${p.host}:${p.port}/acp/ws?agentId=${identity.agentId}#${fragmentParams}`;
    }

    const qrPayload = `shepaw://pair?url=${encodeURIComponent(pairUrl)}&code=${encodeURIComponent(token.code)}`;

    res.status(201).json({
      ...token,
      display: formatCodeForDisplay(token.code),
      pairUrl,
      qrPayload,
      agentId: identity.agentId,
      fingerprint: identity.fingerprint,
    });
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(400).json({ error: String(err) });
    }
  }
});

projectsRouter.delete('/:id/enroll/:code', (req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    getProject(cfg, req.params.id!);
    const paths = projectPaths(req.params.id!);
    const ok = revokeEnrollmentToken(paths.enrollmentsPath, req.params.code!);
    if (ok) {
      res.json({ ok: true });
    } else {
      res.status(404).json({ error: `No outstanding code matching "${req.params.code}"` });
    }
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: String(err) });
    }
  }
});
