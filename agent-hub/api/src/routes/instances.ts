/**
 * Instances REST routes.
 *
 * GET    /api/instances               — list all instances with live status
 * GET    /api/instances/meta          — hub metadata: lastTunnelServerUrl + credential hints + defaultResumePrompt
 * POST   /api/instances               — register a new instance (starts by default)
 * GET    /api/instances/:id           — get one instance + state
 * DELETE /api/instances/:id           — unregister (stops first if running)
 * PATCH  /api/instances/:id           — update label/host/cwd/baseUrl/extraArgs/resumePrompt
 * POST   /api/instances/:id/start     — start the gateway process
 * POST   /api/instances/:id/stop      — stop the gateway process
 * POST   /api/instances/restart-all   — restart all running instances
 * GET    /api/instances/:id/peers     — list authorized peers
 * POST   /api/instances/:id/peers     — add a peer { pubkey, label? }
 * DELETE /api/instances/:id/peers/:fp — remove a peer by fingerprint
 * POST   /api/instances/:id/enroll    — mint a new pairing code { label?, ttlMinutes? }
 * GET    /api/instances/:id/enroll    — list outstanding pairing codes
 * DELETE /api/instances/:id/enroll/:code — revoke a pairing code
 * GET    /api/instances/:id/conversations — live session list (agent.sessions.list)
 * GET    /api/instances/:id/conversations/:sessionId/history — session transcript
 * GET    /api/instances/:id/sessions   — list persisted Shepaw→ACP session mappings
 * DELETE /api/instances/:id/sessions/:shepawSessionId — remove a stale mapping
 * GET    /api/instances/:id/envvars   — list env var keys (values masked)
 * PUT    /api/instances/:id/envvars/:key — set a single env var (also updates credential hints cache)
 * DELETE /api/instances/:id/envvars/:key — delete a single env var
 * GET    /api/instances/:id/attachments — list peer-attachments on disk
 * DELETE /api/instances/:id/attachments — clear all peer-attachments
 * DELETE /api/instances/:id/attachments/:name — delete one peer-attachment by filename
 * POST   /api/instances/:id/resume/rebuild — re-derive the workspace resume
 * POST   /api/instances/:id/resume/polish  — AI resume polish (chat-driven)
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
  addInstance,
  allocateInstanceId,
  deleteInstanceEnvVar,
  decryptValue,
  encryptValue,
  ensureInstanceDir,
  getInstance,
  hubRoot,
  listInstanceSessions,
  deleteInstanceSession,
  listInstanceConversations,
  getInstanceConversationHistory,
  getInstanceAgentCard,
  polishInstanceResume,
  rebuildInstanceResume,
  setInstanceResumePrompt,
  InstanceGatewayOfflineError,
  closeInstanceAcpRpcClient,
  applyInstanceSessionMode,
  loadOrCreateHubConfig,
  nextFreePort,
  probeInstanceRuntime,
  instancePaths,
  InstanceExistsError,
  InstanceNotFoundError,
  isSensitiveEnvVarKey,
  listPeerAttachments,
  deletePeerAttachment,
  clearPeerAttachments,
  readState,
  removeInstance,
  restartAllInstances,
  setInstanceEnvVar,
  startInstance,
  stopInstance,
  updateHubMeta,
  updateInstance,
  DEFAULT_RESUME_PROMPT,
  tryAuthorizePeerServiceOnInstance,
  type AgentEngine,
  type CredentialHint,
  type HubCredentialCache,
  type InstanceConfig,
  type TunnelConfig,
  isKnownEngine,
  parseSessionMode,
  isAlive,
  resolvePublicHost,
  ensureAgentStoreMappings,
  hubStoreDeviceId,
  workspaceStoreUri,
  agentPrivateStoreUri,
  gatewayAcpWsBase,
} from '@shepaw/agent-hub-core';

export const instancesRouter = Router();

// ── helpers ────────────────────────────────────────────────────────

async function instanceStatus(instance: InstanceConfig) {
  return probeInstanceRuntime(instance);
}

async function enrichInstance(p: InstanceConfig, opts: { withCard?: boolean } = {}) {
  let store:
    | {
        deviceId: string;
        workspaceUri: string;
        workspaceUris: string[];
        agentUri: string;
      }
    | undefined;
  try {
    const deviceId = hubStoreDeviceId();
    try {
      ensureAgentStoreMappings({
        agentId: p.id,
        cwd: p.cwd,
        additionalDirectories: p.additionalDirectories,
        deviceId,
      });
    } catch {
      /* URI still advertised even if symlink fails */
    }
    const workspaceUri = workspaceStoreUri(deviceId, p.cwd);
    const workspaceUris = [
      workspaceUri,
      ...(p.additionalDirectories ?? []).map((d) => workspaceStoreUri(deviceId, d)),
    ];
    store = {
      deviceId,
      workspaceUri,
      workspaceUris,
      agentUri: agentPrivateStoreUri(deviceId, p.id),
    };
  } catch {
    /* peer identity unavailable — omit store mapping from response */
  }
  const base = {
    ...p,
    // Never expose encrypted envVar values — only the key names.
    envVars: undefined,
    envVarKeys: Object.keys(p.envVars ?? {}),
    status: await instanceStatus(p),
    store,
  };
  if (!opts.withCard) return base;
  // Workspace-grounded resume reported via agent.getCard (null-tolerant: an
  // offline gateway just yields no card, the detail page still renders).
  return { ...base, card: await getInstanceAgentCard(p.id) };
}

function parseEngine(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('Engine must be a non-empty string.');
  }
  const cfg = loadOrCreateHubConfig();
  if (!isKnownEngine(raw, cfg.customEngines)) {
    throw new Error(
      `Invalid engine "${raw}". Use a built-in engine or register a custom one under /api/engines.`,
    );
  }
  return raw;
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

instancesRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    const instances = await Promise.all(cfg.instances.map((p) => enrichInstance(p)));
    res.json(instances);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── hub meta (credential hints + lastTunnelServerUrl) ──────────────

/**
 * GET /api/instances/meta
 * Returns hub-level metadata: lastTunnelServerUrl, per-engine credential
 * hints (masked values only — encrypted blobs are never sent to the client),
 * and the system-default resume prompt for the dashboard editor.
 */
instancesRouter.get('/meta', (_req: Request, res: Response) => {
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

  // Back-fill from existing instances for any engine that has no persisted hint yet.
  // This makes hints available for instances created before the hints cache was introduced,
  // without requiring a migration — the first call to /meta populates the cache.
  let needsPersist = false;
  const updatedHintCache: HubCredentialCache = { ...(cfg.credentialHints ?? {}) };
  for (const instance of cfg.instances) {
    const eng = instance.engine;
    if (hints[eng]) continue;  // already covered by persisted hints
    const envVars = instance.envVars ?? {};
    if (Object.keys(envVars).length === 0) continue;
    // Decrypt and build masked hints for this engine from the first instance found.
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
    defaultResumePrompt: DEFAULT_RESUME_PROMPT,
  });
});

// ── restart all ────────────────────────────────────────────────────

/** POST /api/instances/restart-all — stop then start every running instance. */
instancesRouter.post('/restart-all', async (_req: Request, res: Response) => {
  try {
    const results = await restartAllInstances({
      onStopped: (id) => closeInstanceAcpRpcClient(id),
    });
    const restarted = results.filter((r) => r.wasRunning && r.error === undefined).length;
    const failed = results.filter((r) => r.error !== undefined).length;
    res.json({ restarted, failed, results });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── create ─────────────────────────────────────────────────────────

instancesRouter.post('/', async (req: Request, res: Response) => {
  try {
    const { engine, cwd, label, port, host, baseUrl, extraArgs, tunnel, envVars, sessionMode, additionalDirectories } = req.body as Record<string, unknown>;
    const cfg = loadOrCreateHubConfig();
    const id = allocateInstanceId(cfg.instances.map((p) => p.id));
    const resolvedEngine = parseEngine(engine ?? 'codebuddy');
    const reservedPorts = cfg.instances.map((p) => p.port);
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
    // Decrypt the cached encrypted values so they can be re-encrypted into the new instance.
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

    const resolvedSessionMode = parseSessionMode(resolvedEngine, sessionMode);
    const displayLabel = typeof label === 'string' && label.length > 0 ? label : id;
    const resolvedCwd = typeof cwd === 'string' ? cwd : process.cwd();
    const resolvedAdditional = Array.isArray(additionalDirectories)
      ? additionalDirectories.filter((x): x is string => typeof x === 'string')
      : undefined;
    const instance: Omit<InstanceConfig, 'envVars'> & { plainEnvVars?: Record<string, string> } = {
      id,
      label: displayLabel,
      engine: resolvedEngine,
      cwd: resolvedCwd,
      ...(resolvedAdditional !== undefined && resolvedAdditional.length > 0
        ? { additionalDirectories: resolvedAdditional }
        : {}),
      port: resolvedPort,
      host: typeof host === 'string' ? host : '127.0.0.1',
      baseUrl: resolvedBaseUrl,
      extraArgs: Array.isArray(extraArgs) ? extraArgs.filter((x): x is string => typeof x === 'string') : [],
      createdAt: new Date().toISOString(),
      tunnel: resolvedTunnel,
      ...(resolvedSessionMode !== undefined && { sessionMode: resolvedSessionMode }),
      plainEnvVars: Object.keys(mergedEnvVars).length > 0 ? mergedEnvVars : undefined,
    };

    addInstance(cfg, instance);
    ensureInstanceDir(id);
    tryAuthorizePeerServiceOnInstance(id);
    // Mapping is also done inside addInstance; re-ensure so create response is consistent
    // even if the first attempt warned.
    try {
      ensureAgentStoreMappings({
        agentId: id,
        cwd: instance.cwd,
        additionalDirectories: instance.additionalDirectories,
      });
    } catch {
      /* warned in addInstance */
    }
    const savedCfg = loadOrCreateHubConfig();
    const saved = savedCfg.instances.find((p) => p.id === id) ?? instance as unknown as InstanceConfig;

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

    // Dashboard create = register + start. Pass { start: false } to register only.
    const shouldStart = req.body.start !== false;
    let startError: string | undefined;
    if (shouldStart) {
      try {
        await startInstance(saved);
      } catch (err) {
        startError = err instanceof Error ? err.message : String(err);
        console.warn(`[shepaw-hub] instance "${id}" created but failed to start: ${startError}`);
      }
    }

    const body = await enrichInstance(saved);
    res.status(201).json(startError !== undefined ? { ...body, startError } : body);
  } catch (err) {
    if (err instanceof InstanceExistsError) {
      res.status(409).json({ error: err.message });
    } else {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
});

// ── get one ────────────────────────────────────────────────────────

instancesRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    const p = getInstance(cfg, req.params.id!);
    res.json(await enrichInstance(p, { withCard: true }));
  } catch (err) {
    if (err instanceof InstanceNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: String(err) });
    }
  }
});

// ── delete ─────────────────────────────────────────────────────────

instancesRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    const p = getInstance(cfg, req.params.id!);
    const paths = instancePaths(p.id);
    const state = readState(paths.statePath);
    if (state !== undefined && state.pid > 0 && isAlive(state.pid)) {
      await stopInstance(p);
    }
    closeInstanceAcpRpcClient(p.id);
    removeInstance(cfg, p.id);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof InstanceNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: String(err) });
    }
  }
});

// ── patch ──────────────────────────────────────────────────────────

instancesRouter.patch('/:id', async (req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    const existing = getInstance(cfg, req.params.id!);
    const { label, host, baseUrl, cwd, extraArgs, tunnel, clearTunnel, envVars, clearEnvVars, sessionMode, additionalDirectories, resumePrompt } = req.body as Record<string, unknown>;
    const patch: Parameters<typeof updateInstance>[2] = {};
    let nextSessionMode: string | undefined;
    if (typeof label === 'string') patch.label = label;
    if (typeof host === 'string') patch.host = host;
    if (typeof cwd === 'string') patch.cwd = cwd;
    if (resumePrompt !== undefined) {
      if (typeof resumePrompt !== 'string') {
        res.status(400).json({ error: '"resumePrompt" must be a string.' });
        return;
      }
      patch.resumePrompt = resumePrompt;
    }
    if (additionalDirectories !== undefined) {
      if (!Array.isArray(additionalDirectories)) {
        res.status(400).json({ error: '"additionalDirectories" must be an array of strings.' });
        return;
      }
      (patch as { additionalDirectories?: string[] }).additionalDirectories =
        additionalDirectories.filter((x): x is string => typeof x === 'string');
    }
    if (sessionMode !== undefined) {
      const parsed = parseSessionMode(existing.engine, sessionMode);
      if (parsed !== undefined) {
        patch.sessionMode = parsed;
        nextSessionMode = parsed;
      }
    }
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
    const next = updateInstance(cfg, req.params.id!, patch);
    const updated = next.instances.find((p) => p.id === req.params.id)!;

    if (nextSessionMode !== undefined) {
      const runtime = await probeInstanceRuntime(updated);
      if (runtime.availability === 'online' || runtime.availability === 'degraded') {
        try {
          await applyInstanceSessionMode(updated.id, nextSessionMode);
        } catch (err) {
          console.warn(
            `[shepaw-hub] saved sessionMode="${nextSessionMode}" for ${updated.id} ` +
              `but live apply failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    // Live-apply a resume-prompt change to a running gateway so the next
    // rebuild/polish uses it without a restart. Offline → skip silently; the
    // spawn-time SHEPAW_RESUME_PROMPT env fallback still applies on next start.
    if (patch.resumePrompt !== undefined) {
      const runtime = await probeInstanceRuntime(updated);
      if (runtime.availability === 'online' || runtime.availability === 'degraded') {
        const applied = await setInstanceResumePrompt(updated.id, updated.resumePrompt ?? '');
        if (applied === null) {
          console.warn(
            `[shepaw-hub] saved resumePrompt for ${updated.id} but live apply failed ` +
              '(gateway may predate agent.resume.promptSet); env fallback applies on next start.',
          );
        }
      }
    }

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

    res.json(await enrichInstance(updated));
  } catch (err) {
    if (err instanceof InstanceNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(400).json({ error: String(err) });
    }
  }
});

// ── start ──────────────────────────────────────────────────────────

instancesRouter.post('/:id/start', async (req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    const p = getInstance(cfg, req.params.id!);
    ensureInstanceDir(p.id);
    tryAuthorizePeerServiceOnInstance(p.id);
    const result = await startInstance(p);
    res.json({ pid: result.pid, alreadyRunning: result.alreadyRunning });
  } catch (err) {
    if (err instanceof InstanceNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
});

// ── stop ───────────────────────────────────────────────────────────

instancesRouter.post('/:id/stop', async (req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    const p = getInstance(cfg, req.params.id!);
    const result = await stopInstance(p);
    closeInstanceAcpRpcClient(p.id);
    res.json({ result });
  } catch (err) {
    if (err instanceof InstanceNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: String(err) });
    }
  }
});

// ── resume ─────────────────────────────────────────────────────────

/** POST /api/instances/:id/resume/rebuild — re-derive the agent's workspace
 * resume on the running gateway and return the fresh card. */
instancesRouter.post('/:id/resume/rebuild', async (req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    const p = getInstance(cfg, req.params.id!);
    // Always pass the config prompt so a stale gateway override can't win.
    const card = await rebuildInstanceResume(p.id, p.resumePrompt ?? '');
    if (card === null) {
      res.status(502).json({
        error: 'Resume rebuild failed: gateway offline or agent does not support agent.resume.rebuild.',
      });
      return;
    }
    res.json({ ok: true, card });
  } catch (err) {
    if (err instanceof InstanceNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
});

/**
 * POST /api/instances/:id/resume/polish — AI resume polish. First re-derives
 * the workspace resume deterministically (fresh capability list from the
 * current scan), then drives one chat turn that makes the agent rewrite its
 * own Summary per the custom resume prompt. One button covers both facts
 * refresh and AI rewrite — the standalone rebuild endpoint stays available
 * for CLI / API callers.
 */
instancesRouter.post('/:id/resume/polish', async (req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    const p = getInstance(cfg, req.params.id!);
    // No custom prompt saved → polish against the system default (the same
    // text the dashboard editor pre-fills), so polish works out of the box.
    const prompt = (p.resumePrompt ?? '').trim() || DEFAULT_RESUME_PROMPT;
    // Fail fast on an offline gateway instead of hanging a 3-minute chat.
    const runtime = await probeInstanceRuntime(p);
    if (runtime.availability !== 'online' && runtime.availability !== 'degraded') {
      closeInstanceAcpRpcClient(p.id);
      res.status(502).json({
        error: runtime.probeError ?? '网关离线，无法进行 AI 润色。请先启动实例。',
      });
      return;
    }
    // Refresh the objective facts (capabilities, workspace, git) so the agent
    // rewrites its Summary on top of a current scan. The rebuild preserves an
    // AI-polished Summary while the prompt is unchanged, and the polish turn
    // below replaces the Summary anyway.
    await rebuildInstanceResume(p.id);
    const result = await polishInstanceResume(p.id, p.id, prompt, p.cwd, p.label);
    if (!result.ok) {
      res.status(502).json({ error: result.error ?? 'AI 润色失败。', reply: result.reply });
      return;
    }
    res.json(result);
  } catch (err) {
    if (err instanceof InstanceNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
});

// ── envvars ────────────────────────────────────────────────────────

/** GET /api/instances/:id/envvars — list keys; secrets masked, non-secrets plaintext */
instancesRouter.get('/:id/envvars', (req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    const p = getInstance(cfg, req.params.id!);
    const root = hubRoot();
    const result = Object.entries(p.envVars ?? {}).map(([key, encrypted]) => {
      const sensitive = isSensitiveEnvVarKey(key);
      let value = sensitive ? '••••••••' : '';
      try {
        const plain = decryptValue(encrypted, root);
        value = sensitive ? maskSecretValue(plain) : plain;
      } catch {
        // decryption failed — fall back to generic mask / empty
      }
      return { key, value, sensitive };
    });
    res.json(result);
  } catch (err) {
    if (err instanceof InstanceNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: String(err) });
    }
  }
});

/** PUT /api/instances/:id/envvars/:key — set (or replace) a single env var */
instancesRouter.put('/:id/envvars/:key', (req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    const p = getInstance(cfg, req.params.id!);
    const { value } = req.body as Record<string, unknown>;
    if (typeof value !== 'string') {
      res.status(400).json({ error: '"value" must be a string' });
      return;
    }
    setInstanceEnvVar(cfg, req.params.id!, req.params.key!, value);
    // Update credential hints cache for this engine.
    if (value.length > 0) {
      const freshCfg = loadOrCreateHubConfig();
      updateHubMeta(freshCfg, {
        credentialHints: buildCredentialHints(freshCfg.credentialHints, p.engine, { [req.params.key!]: value }),
      });
    }
    res.json({ ok: true, key: req.params.key });
  } catch (err) {
    if (err instanceof InstanceNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(400).json({ error: String(err) });
    }
  }
});

/** DELETE /api/instances/:id/envvars/:key — remove a single env var */
instancesRouter.delete('/:id/envvars/:key', (req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    getInstance(cfg, req.params.id!);
    deleteInstanceEnvVar(cfg, req.params.id!, req.params.key!);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof InstanceNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: String(err) });
    }
  }
});

// ── peers ──────────────────────────────────────────────────────────

instancesRouter.get('/:id/peers', (req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    getInstance(cfg, req.params.id!);
    const paths = instancePaths(req.params.id!);
    const peers = loadOrCreatePeers({ path: paths.peersPath });
    res.json(peers.peers);
  } catch (err) {
    if (err instanceof InstanceNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: String(err) });
    }
  }
});

instancesRouter.post('/:id/peers', (req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    getInstance(cfg, req.params.id!);
    const { pubkey, label } = req.body as Record<string, unknown>;
    if (typeof pubkey !== 'string' || pubkey.length === 0) {
      res.status(400).json({ error: 'pubkey is required' });
      return;
    }
    const paths = instancePaths(req.params.id!);
    const entry = addPeer(paths.peersPath, pubkey, typeof label === 'string' ? label : undefined);
    res.status(201).json(entry);
  } catch (err) {
    if (err instanceof InstanceNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(400).json({ error: String(err) });
    }
  }
});

instancesRouter.delete('/:id/peers/:fp', (req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    getInstance(cfg, req.params.id!);
    const paths = instancePaths(req.params.id!);
    const removed = removePeerByFingerprint(paths.peersPath, req.params.fp!);
    if (removed) {
      res.json({ ok: true });
    } else {
      res.status(404).json({ error: `No peer with fingerprint ${req.params.fp}` });
    }
  } catch (err) {
    if (err instanceof InstanceNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: String(err) });
    }
  }
});

// ── enrollment ─────────────────────────────────────────────────────

instancesRouter.get('/:id/enroll', (req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    getInstance(cfg, req.params.id!);
    const paths = instancePaths(req.params.id!);
    const store = loadOrCreateEnrollments({ path: paths.enrollmentsPath });
    res.json(store.tokens.map((t) => ({ ...t, display: formatCodeForDisplay(t.code) })));
  } catch (err) {
    if (err instanceof InstanceNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: String(err) });
    }
  }
});

instancesRouter.post('/:id/enroll', (req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    const p = getInstance(cfg, req.params.id!);
    const paths = instancePaths(req.params.id!);
    ensureInstanceDir(req.params.id!);

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

    // Priority mirrors pairing.ts: explicit --base-url → gateway exposure
    // (shared Channel `/proxy/<channelId>` or reverse proxy `/p/<id>`) →
    // legacy per-instance baseUrl → LAN loopback. Routing by `/p/<instanceId>`
    // through the tunnel router means Channel / reverse-proxy machines no
    // longer fall back to a LAN address the phone can't reach.
    const explicitBase = typeof baseUrl === 'string' && baseUrl.length > 0 ? baseUrl : undefined;
    const gatewayBase = gatewayAcpWsBase(cfg);
    let pairUrl: string;
    if (explicitBase) {
      const clean = explicitBase.replace(/\/$/, '');
      pairUrl = `${clean}/acp/ws?agentId=${identity.agentId}#${fragmentParams}`;
    } else if (gatewayBase) {
      pairUrl = `${gatewayBase}/p/${encodeURIComponent(p.id)}/acp/ws?agentId=${identity.agentId}#${fragmentParams}`;
    } else if (p.baseUrl) {
      const clean = p.baseUrl.replace(/\/$/, '');
      pairUrl = `${clean}/acp/ws?agentId=${identity.agentId}#${fragmentParams}`;
    } else {
      const host = resolvePublicHost(p.host);
      pairUrl = `ws://${host}:${p.port}/acp/ws?agentId=${identity.agentId}#${fragmentParams}`;
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
    if (err instanceof InstanceNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(400).json({ error: String(err) });
    }
  }
});

instancesRouter.delete('/:id/enroll/:code', (req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    getInstance(cfg, req.params.id!);
    const paths = instancePaths(req.params.id!);
    const ok = revokeEnrollmentToken(paths.enrollmentsPath, req.params.code!);
    if (ok) {
      res.json({ ok: true });
    } else {
      res.status(404).json({ error: `No outstanding code matching "${req.params.code}"` });
    }
  } catch (err) {
    if (err instanceof InstanceNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: String(err) });
    }
  }
});

// ── conversations (live gateway sessions) ────────────────────────

instancesRouter.get('/:id/conversations', async (req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    getInstance(cfg, req.params.id!);
    const sessions = await listInstanceConversations(req.params.id!);
    res.json({ sessions });
  } catch (err) {
    if (err instanceof InstanceNotFoundError) {
      res.status(404).json({ error: err.message });
    } else if (err instanceof InstanceGatewayOfflineError) {
      res.status(503).json({ error: err.message });
    } else {
      res.status(500).json({ error: String(err) });
    }
  }
});

instancesRouter.get('/:id/conversations/:sessionId/history', async (req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    getInstance(cfg, req.params.id!);
    const messages = await getInstanceConversationHistory(req.params.id!, req.params.sessionId!);
    res.json({ session_id: req.params.sessionId, messages });
  } catch (err) {
    if (err instanceof InstanceNotFoundError) {
      res.status(404).json({ error: err.message });
    } else if (err instanceof InstanceGatewayOfflineError) {
      res.status(503).json({ error: err.message });
    } else {
      res.status(500).json({ error: String(err) });
    }
  }
});

// ── sessions (persisted ID mappings) ─────────────────────────────

instancesRouter.get('/:id/sessions', (req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    getInstance(cfg, req.params.id!);
    const sessions = listInstanceSessions(req.params.id!);
    res.json({ sessions });
  } catch (err) {
    if (err instanceof InstanceNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: String(err) });
    }
  }
});

instancesRouter.delete('/:id/sessions/:shepawSessionId', (req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    getInstance(cfg, req.params.id!);
    const removed = deleteInstanceSession(req.params.id!, req.params.shepawSessionId!);
    if (!removed) {
      res.status(404).json({ error: `No session mapping for "${req.params.shepawSessionId}".` });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof InstanceNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: String(err) });
    }
  }
});

// ── peer attachments ───────────────────────────────────────────────

instancesRouter.get('/:id/attachments', (req: Request, res: Response) => {
  try {
    const attachments = listPeerAttachments(req.params.id!);
    res.json({ attachments });
  } catch (err) {
    if (err instanceof InstanceNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: String(err) });
    }
  }
});

instancesRouter.delete('/:id/attachments', (req: Request, res: Response) => {
  try {
    const deleted = clearPeerAttachments(req.params.id!);
    res.json({ ok: true, deleted });
  } catch (err) {
    if (err instanceof InstanceNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: String(err) });
    }
  }
});

instancesRouter.delete('/:id/attachments/:name', (req: Request, res: Response) => {
  try {
    const removed = deletePeerAttachment(req.params.id!, req.params.name!);
    if (!removed) {
      res.status(404).json({ error: `No attachment named "${req.params.name}".` });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof InstanceNotFoundError) {
      res.status(404).json({ error: err.message });
    } else if (err instanceof Error && /Invalid attachment name|Attachment name is required|Not a file/.test(err.message)) {
      res.status(400).json({ error: err.message });
    } else {
      res.status(500).json({ error: String(err) });
    }
  }
});
