import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk/msteams";

// ─── Config types ──────────────────────────────────────────────────────────

export type ShepawChannelConfig = {
  enabled?: boolean;
  /** Auth token that Shepaw App must supply in auth.authenticate. */
  token?: string;
  /** Port to listen on. Defaults to 8765. */
  port?: number;
  /** Bind address. Defaults to 127.0.0.1 (loopback). */
  host?: string;
  /** Agent display name shown in Shepaw. */
  agentName?: string;
  /** Agent description shown in Shepaw. */
  agentDescription?: string;
};

const DEFAULT_ACCOUNT_ID = "default";
const DEFAULT_PORT = 8765;
const DEFAULT_HOST = "127.0.0.1";

type ResolvedShepawAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
};

function resolveShepawCfg(cfg: OpenClawConfig): ShepawChannelConfig | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (cfg as any).channels?.shepaw as ShepawChannelConfig | undefined;
}

// ─── Channel plugin ────────────────────────────────────────────────────────

export const shepawPlugin: ChannelPlugin<ResolvedShepawAccount> = {
  id: "shepaw",
  meta: {
    id: "shepaw",
    label: "Shepaw",
    selectionLabel: "Shepaw (Remote LLM Agent)",
    docsPath: "/channels/shepaw",
    blurb: "Connect OpenClaw as a remote LLM agent in the Shepaw app via ACP WebSocket.",
    order: 90,
  },
  capabilities: {
    chatTypes: ["direct"],
    polls: false,
    threads: false,
    media: false,
  },
  reload: { configPrefixes: ["channels.shepaw"] },
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg) => {
      const shepawCfg = resolveShepawCfg(cfg);
      return {
        accountId: DEFAULT_ACCOUNT_ID,
        enabled: shepawCfg?.enabled !== false,
        configured: Boolean(shepawCfg),
      };
    },
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: (_account, cfg) => Boolean(resolveShepawCfg(cfg)),
    isEnabled: (account) => account.enabled,
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
    }),
    setAccountEnabled: ({ cfg, enabled }) => ({
      ...cfg,
      channels: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(cfg as any).channels,
        shepaw: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ...(cfg as any).channels?.shepaw,
          enabled,
        },
      },
    }),
    deleteAccount: ({ cfg }) => {
      const next = { ...cfg } as OpenClawConfig;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const nextChannels = { ...(cfg as any).channels };
      delete nextChannels.shepaw;
      if (Object.keys(nextChannels).length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (next as any).channels = nextChannels;
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (next as any).channels;
      }
      return next;
    },
  },
  setup: {
    resolveAccountId: () => DEFAULT_ACCOUNT_ID,
    applyAccountConfig: ({ cfg, input }) => ({
      ...cfg,
      channels: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(cfg as any).channels,
        shepaw: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ...(cfg as any).channels?.shepaw,
          enabled: true,
          ...(input?.token ? { token: input.token } : {}),
          ...(input?.httpPort ? { port: parseInt(input.httpPort, 10) } : {}),
          ...(input?.httpHost ? { host: input.httpHost } : {}),
        },
      },
    }),
  },
  status: {
    probeAccount: async ({ account, cfg }) => {
      const shepawCfg = resolveShepawCfg(cfg);
      const port = shepawCfg?.port ?? DEFAULT_PORT;
      return { ok: account.enabled && account.configured, port };
    },
    buildAccountSnapshot: ({ account, cfg, probe }) => {
      const shepawCfg = resolveShepawCfg(cfg);
      const port = shepawCfg?.port ?? DEFAULT_PORT;
      return {
        accountId: account.accountId,
        enabled: account.enabled,
        configured: account.configured,
        port,
        ...(probe && typeof probe === "object" ? probe : {}),
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const { startShepawServer } = await import("./server.js");
      const shepawCfg = resolveShepawCfg(ctx.cfg);
      const port = shepawCfg?.port ?? DEFAULT_PORT;
      const host = shepawCfg?.host ?? DEFAULT_HOST;

      ctx.setStatus({ accountId: ctx.accountId, port });
      ctx.log?.info(`shepaw: starting ACP server on ${host}:${port}`);

      return startShepawServer({
        cfg: ctx.cfg,
        token: shepawCfg?.token,
        port,
        host,
        agentName: shepawCfg?.agentName ?? "OpenClaw",
        agentDescription: shepawCfg?.agentDescription ?? "OpenClaw AI assistant",
        abortSignal: ctx.abortSignal,
      });
    },
    stopAccount: async (ctx) => {
      ctx.log?.info("shepaw: stopping ACP server");
    },
  },
};
