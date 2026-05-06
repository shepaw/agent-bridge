/**
 * Projects REST routes.
 *
 * GET    /api/projects               — list all projects with live status
 * GET    /api/projects/meta          — hub metadata: lastTunnelServerUrl + credential hints
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
 * PUT    /api/projects/:id/envvars/:key — set a single env var (also updates credential hints cache)
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
  decryptValue,
  encryptValue,
  ensureProjectDir,
  getProject,
  hubRoot,
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
  updateHubMeta,
  updateProject,
  type AgentEngine,
  type CredentialHint,
  type HubCredentialCache,
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

// ── credential hint helpers ────────────────────────────────────────

/**
 * Produce a masked display string for a secret value.
 * Shows the first few and last few chars; masks the middle with ***.
 */
function maskSecretValue(secret: string): string {
  if (!secret) return '';
  const len = secret.length;
  if (len <= 4) return '*'.repeat(len);
  const headLen = Math.min(4, Math.floor(len / 3));
  const tailLen = Math.min(4, Math.floor(len / 4));
  const head = secret.slice(0, headLen);
  const tail = secret.slice(len - tailLen);
  return `${head}***${tail}`;
}

/**
 * Build an updated credential hints cache by merging new plaintext env vars
 * for a given engine into the existing cache.
 */
function buildCredentialHints(
  existing: HubCredentialCache | undefined,
  engine: AgentEngine,
  plainEnvVars: Record<string, string>,
): HubCredentialCache {
  const root = hubRoot();
  const current = existing ?? {};
  const engineHints: Record<string, CredentialHint> = { ...(current[engine] ?? {}) };
  for (const [key, value] of Object.entries(plainEnvVars)) {
    if (value.length === 0) continue;
    engineHints[key] = {
      masked: maskSecretValue(value),
      encrypted: encryptValue(value, root),
    };
  }
  return { ...current, [engine]: engineHints };
}

// ── list all ───────────────────────────────────────────────────────

projectsRouter.get('/', (_req: Request, res: Response) => {
  const cfg = loadOrCreateHubConfig();
  res.json(cfg.projects.map(enrichProject));
});

// ── hub meta (credential hints + lastTunnelServerUrl) ──────────────

/**
 * GET /api/projects/meta
 * Returns hub-level metadata: lastTunnelServerUrl and per-engine credential
 * hints (masked values only — encrypted blobs are never sent to the client).
 */
projectsRouter.get('/meta', (_req: Request, res: Response) => {
  const cfg = loadOrCreateHubConfig();
  const root = hubRoot();

  // Start with persisted hints.
  const hints: Record<string, Record<string, string>> = {};
  if (cfg.credentialHints) {
    for (const [engine, engineHints] of Object.entries(cfg.credentialHints)) {
      if (engineHints) {
        hints[engine] = Object.fromEntries(
          Object.entries(engineHints).map(([key, hint]) => [key, hint.masked]),
        );
      }
    }
  }

  // Back-fill from existing projects for any engine that has no persisted hint yet.
  // This makes hints available for projects created before the hints cache was introduced,
  // without requiring a migration — the first call to /meta populates the cache.
  let needsPersist = false;
  const updatedHintCache: HubCredentialCache = { ...(cfg.credentialHints ?? {}) };
  for (const project of cfg.projects) {
    const eng = project.engine;
    if (hints[eng]) continue;  // already covered by persisted hints
    const envVars = project.envVars ?? {};
    if (Object.keys(envVars).length === 0) continue;
    // Decrypt and build masked hints for this engine from the first project found.
    const engineHints: Record<string, CredentialHint> = { ...(updatedHintCache[eng] ?? {}) };
    let changed = false;
    for (const [key, encrypted] of Object.entries(envVars)) {
      if (engineHints[key]) continue; // already have a hint for this key
      try {
        const plain = decryptValue(encrypted, root);
        engineHints[key] = { masked: maskSecretValue(plain), encrypted };
        changed = true;
      } catch {
        // skip keys that fail to decrypt
      }
    }
    if (changed) {
      updatedHintCache[eng] = engineHints;
      hints[eng] = Object.fromEntries(
        Object.entries(engineHints).map(([key, hint]) => [key, hint.masked]),
      );
      needsPersist = true;
    }
  }

  // Persist the newly built hints so subsequent calls don't re-decrypt.
  if (needsPersist) {
    updateHubMeta(cfg, { credentialHints: updatedHintCache });
  }

  res.json({
    lastTunnelServerUrl: cfg.lastTunnelServerUrl ?? null,
    lastTunnelSecretHint: cfg.lastTunnelSecretHint?.masked ?? null,
    credentialHints: hints,
  });
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

    // Build explicit envVars from request body
    const explicitEnvVars: Record<string, string> = (envVars !== undefined && typeof envVars === 'object' && !Array.isArray(envVars))
      ? Object.fromEntries(
          Object.entries(envVars as Record<string, unknown>)
            .filter(([, v]) => typeof v === 'string')
            .map(([k, v]) => [k, v as string]),
        )
      : {};

    // Merge in cached credentials for keys the user did NOT explicitly provide.
    // Decrypt the cached encrypted values so they can be re-encrypted into the new project.
    const root = hubRoot();
    const engineHints = cfg.credentialHints?.[resolvedEngine] ?? {};
    const mergedEnvVars: Record<string, string> = { ...explicitEnvVars };
    for (const [key, hint] of Object.entries(engineHints)) {
      if (!(key in mergedEnvVars)) {
        try {
          mergedEnvVars[key] = decryptValue(hint.encrypted, root);
        } catch {
          // If decryption fails, skip this hint silently
        }
      }
    }

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
      plainEnvVars: Object.keys(mergedEnvVars).length > 0 ? mergedEnvVars : undefined,
    };

    addProject(cfg, project);
    ensureProjectDir(id);
    const savedCfg = loadOrCreateHubConfig();
    const saved = savedCfg.projects.find((p) => p.id === id) ?? project as unknown as ProjectConfig;

    // Update hub-level metadata: cache credential hints, lastTunnelServerUrl, tunnel secret hint.
    // Only update hints for keys the user explicitly provided (not auto-filled from cache).
    const hasNewEnvVars = Object.keys(explicitEnvVars).length > 0;
    const hasTunnel = resolvedTunnel !== undefined;
    if (hasNewEnvVars || hasTunnel) {
      const root = hubRoot();
      const meta: { lastTunnelServerUrl?: string; lastTunnelSecretHint?: CredentialHint; credentialHints?: HubCredentialCache } = {};
      if (hasTunnel) {
        meta.lastTunnelServerUrl = resolvedTunnel!.serverUrl;
        meta.lastTunnelSecretHint = {
          masked: maskSecretValue(resolvedTunnel!.secret),
          encrypted: encryptValue(resolvedTunnel!.secret, root),
        };
      }
      if (hasNewEnvVars) {
        meta.credentialHints = buildCredentialHints(savedCfg.credentialHints, resolvedEngine, explicitEnvVars);
      }
      updateHubMeta(savedCfg, meta);
    }

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
    const existing = getProject(cfg, req.params.id!);
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
      } else {
        // secret may be blank (user kept existing) — try partial parse with secret fallback
        const obj = (tunnel !== null && typeof tunnel === 'object') ? tunnel as Record<string, unknown> : {};
        const serverUrl = typeof obj.serverUrl === 'string' ? obj.serverUrl : '';
        const channelId = typeof obj.channelId === 'string' ? obj.channelId : '';
        const secret = (typeof obj.secret === 'string' && obj.secret.length > 0)
          ? obj.secret
          : existing.tunnel?.secret ?? '';
        if (serverUrl && channelId && secret) {
          patch.tunnel = { serverUrl, channelId, secret };
          if (typeof baseUrl !== 'string') {
            patch.baseUrl = `${serverUrl}/proxy/${channelId}`;
          }
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

    // If a new tunnel was set, update lastTunnelServerUrl and lastTunnelSecretHint in hub meta.
    if (patch.tunnel) {
      const root = hubRoot();
      const freshCfg = loadOrCreateHubConfig();
      updateHubMeta(freshCfg, {
        lastTunnelServerUrl: patch.tunnel.serverUrl,
        lastTunnelSecretHint: {
          masked: maskSecretValue(patch.tunnel.secret),
          encrypted: encryptValue(patch.tunnel.secret, root),
        },
      });
    }

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

/** GET /api/projects/:id/envvars — list keys with masked values (first/last chars visible) */
projectsRouter.get('/:id/envvars', (req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    const p = getProject(cfg, req.params.id!);
    const root = hubRoot();
    const result = Object.entries(p.envVars ?? {}).map(([key, encrypted]) => {
      let masked = '••••••••';
      try {
        const plain = decryptValue(encrypted, root);
        masked = maskSecretValue(plain);
      } catch {
        // decryption failed — fall back to generic mask
      }
      return { key, value: masked };
    });
    res.json(result);
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
    const p = getProject(cfg, req.params.id!);
    const { value } = req.body as Record<string, unknown>;
    if (typeof value !== 'string') {
      res.status(400).json({ error: '"value" must be a string' });
      return;
    }
    setProjectEnvVar(cfg, req.params.id!, req.params.key!, value);
    // Update credential hints cache for this engine.
    if (value.length > 0) {
      const freshCfg = loadOrCreateHubConfig();
      updateHubMeta(freshCfg, {
        credentialHints: buildCredentialHints(freshCfg.credentialHints, p.engine, { [req.params.key!]: value }),
      });
    }
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
