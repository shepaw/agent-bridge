/**
 * Shepaw ACP WebSocket server.
 *
 * OpenClaw acts as a Remote LLM Agent in the Shepaw app.  The Shepaw Flutter
 * client connects to this server, sends `agent.chat` requests, and receives
 * streaming `ui.textContent` notifications back.
 *
 * Protocol: ACP 1.0 — JSON-RPC 2.0 over WebSocket (RFC 6455).
 *
 * Message flow per `agent.chat`:
 *   1. Acknowledge immediately (JSON-RPC response)
 *   2. Send `task.started`
 *   3. Stream `ui.textContent` chunks (is_final=false) via deliver callback
 *   4. Send `ui.textContent` with is_final=true
 *   5. Send `task.completed`
 */

import { createServer, type Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { OpenClawConfig } from "openclaw/plugin-sdk/msteams";
import {
  resolveInboundSessionEnvelopeContext,
  createReplyPrefixOptions,
} from "openclaw/plugin-sdk/msteams";
import { getShepawRuntime } from "./runtime.js";
import type {
  AcpConnectionState,
  AgentChatParams,
  AcpHistoryEntry,
  JsonRpcId,
  JsonRpcMessage,
} from "./types.js";

// ─── JSON-RPC helpers ──────────────────────────────────────────────────────

function rpcOk(id: JsonRpcId, result: unknown = {}): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function rpcErr(id: JsonRpcId, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

function notify(method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", method, params });
}

function nowIso(): string {
  return new Date().toISOString();
}

// ─── Config helpers ─────────────────────────────────────────────────────────

export type ShepawServerConfig = {
  cfg: OpenClawConfig;
  token?: string;
  port: number;
  host?: string;
  agentName?: string;
  agentDescription?: string;
  agentVersion?: string;
  abortSignal?: AbortSignal;
};

// ─── Main server ────────────────────────────────────────────────────────────

export type ShepawServerResult = {
  httpServer: Server;
  shutdown: () => Promise<void>;
};

/**
 * Start the Shepaw ACP WebSocket server and return a handle for graceful
 * shutdown.  Called from the channel gateway adapter.
 */
export async function startShepawServer(opts: ShepawServerConfig): Promise<ShepawServerResult> {
  const {
    cfg,
    token,
    port,
    host = "0.0.0.0",
    agentName = "OpenClaw",
    agentDescription = "OpenClaw AI assistant via Shepaw ACP",
    agentVersion = "1.0.0",
    abortSignal,
  } = opts;

  const core = getShepawRuntime();
  const log = core.logging.getChildLogger({ name: "shepaw" });

  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws: WebSocket) => {
    const state: AcpConnectionState = {
      authenticated: false,
      pending: new Map(),
      activeTasks: new Map(),
    };

    log.debug?.("shepaw: new connection");

    ws.on("message", (raw) => {
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(raw.toString()) as JsonRpcMessage;
      } catch {
        ws.send(rpcErr(null, -32700, "Parse error"));
        return;
      }

      // Dispatch: requests have both id and method; responses have id but no method.
      if ("id" in msg && "method" in msg) {
        // Request from Shepaw App
        void handleRequest(ws, msg as { id: JsonRpcId; method: string; params?: unknown }, state, {
          cfg,
          token,
          agentName,
          agentDescription,
          agentVersion,
          log,
        });
      } else if ("id" in msg && !("method" in msg)) {
        // Response to a hub.* request we sent
        const id = String((msg as { id: JsonRpcId }).id);
        const entry = state.pending.get(id);
        if (entry) {
          state.pending.delete(id);
          const resp = msg as { id: JsonRpcId; result?: unknown; error?: { message: string } };
          if (resp.error) {
            entry.reject(new Error(resp.error.message));
          } else {
            entry.resolve(resp.result);
          }
        }
      }
    });

    ws.on("close", () => {
      log.debug?.("shepaw: connection closed");
      // Cancel all in-progress tasks.
      for (const ac of state.activeTasks.values()) {
        ac.abort();
      }
      state.activeTasks.clear();
      // Reject pending hub futures.
      for (const entry of state.pending.values()) {
        entry.reject(new Error("WebSocket closed"));
      }
      state.pending.clear();
    });

    ws.on("error", (err) => {
      log.warn?.(`shepaw: WebSocket error: ${String(err)}`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      log.info(`shepaw ACP server listening on ${host}:${port}`);
      resolve();
    });
  });

  // Auto-shutdown when the gateway abort signal fires.
  abortSignal?.addEventListener("abort", () => {
    log.debug?.("shepaw: abort signal received, shutting down");
    wss.close();
    httpServer.close();
  });

  const shutdown = async (): Promise<void> => {
    await new Promise<void>((res) => {
      wss.close(() => {
        httpServer.close(() => res());
      });
    });
  };

  return { httpServer, shutdown };
}

// ─── Request dispatcher ────────────────────────────────────────────────────

type HandlerCtx = {
  cfg: OpenClawConfig;
  token?: string;
  agentName: string;
  agentDescription: string;
  agentVersion: string;
  log: ReturnType<ReturnType<typeof getShepawRuntime>["logging"]["getChildLogger"]>;
};

async function handleRequest(
  ws: WebSocket,
  msg: { id: JsonRpcId; method: string; params?: unknown },
  state: AcpConnectionState,
  ctx: HandlerCtx,
): Promise<void> {
  const { id, method, params = {} } = msg;
  const p = params as Record<string, unknown>;

  if (method === "ping") {
    ws.send(rpcOk(id, { pong: true }));
    return;
  }

  if (method === "auth.authenticate") {
    const incoming = p["token"] as string | undefined;
    if (!ctx.token || incoming === ctx.token) {
      state.authenticated = true;
      ws.send(rpcOk(id, { status: "authenticated" }));
    } else {
      ws.send(rpcErr(id, -32000, "Authentication failed"));
    }
    return;
  }

  if (!state.authenticated) {
    ws.send(rpcErr(id, -32001, "Not authenticated"));
    return;
  }

  switch (method) {
    case "agent.getCard": {
      ws.send(
        rpcOk(id, {
          agent_id: "openclaw",
          name: ctx.agentName,
          description: ctx.agentDescription,
          version: ctx.agentVersion,
          capabilities: ["chat", "streaming"],
          supported_protocols: ["acp"],
        }),
      );
      break;
    }

    case "agent.chat": {
      const chatParams = p as unknown as AgentChatParams;
      const taskId = chatParams.task_id ?? String(Math.random());
      const ac = new AbortController();
      state.activeTasks.set(taskId, ac);

      // Acknowledge immediately (do not await the full response).
      ws.send(rpcOk(id, { task_id: taskId, status: "accepted" }));

      void handleChat(ws, chatParams, ac.signal, ctx).finally(() => {
        state.activeTasks.delete(taskId);
      });
      break;
    }

    case "agent.cancelTask": {
      const taskId = p["task_id"] as string | undefined;
      if (taskId) {
        const ac = state.activeTasks.get(taskId);
        if (ac) {
          ac.abort();
          state.activeTasks.delete(taskId);
        }
      }
      ws.send(rpcOk(id, { task_id: taskId, status: "cancelled" }));
      break;
    }

    case "agent.submitResponse": {
      // UI component response — no-op for now (we don't send interactive UI).
      ws.send(rpcOk(id, { status: "received" }));
      break;
    }

    case "agent.rollback": {
      // History rollback — OpenClaw manages history server-side; acknowledge.
      ws.send(rpcOk(id, { status: "ok" }));
      break;
    }

    default: {
      ws.send(rpcErr(id, -32601, `Method not found: ${method}`));
    }
  }
}

// ─── Chat handler ──────────────────────────────────────────────────────────

async function handleChat(
  ws: WebSocket,
  params: AgentChatParams,
  abortSignal: AbortSignal,
  ctx: HandlerCtx,
): Promise<void> {
  const core = getShepawRuntime();
  const { log } = ctx;
  const taskId = params.task_id;
  const sessionId = params.session_id ?? taskId;
  const userId = params.user_id ?? "unknown";
  const messageText = params.message ?? "";
  const attachments = params.attachments ?? [];

  const send = (data: string) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  };

  // task.started
  send(notify("task.started", { task_id: taskId, started_at: nowIso() }));

  try {
    // Build body for the AI engine. Include attachment info as text hints.
    let body = messageText;
    if (attachments.length > 0) {
      const attSummary = attachments
        .map((a) => `[${a.type}: ${a.file_name}]`)
        .join(", ");
      body = body ? `${body}\n${attSummary}` : attSummary;
    }

    // Prepend conversation history from Shepaw when starting a new session.
    const history: AcpHistoryEntry[] = params.history ?? [];

    // Build the inbound context — use the session_id as the sender identifier
    // so each Shepaw conversation maps to a distinct OpenClaw session.
    const senderFrom = `shepaw:${userId}`;
    const senderTo = `shepaw:session:${sessionId}`;

    const route = core.channel.routing.resolveAgentRoute({
      cfg: ctx.cfg,
      channel: "shepaw",
      peer: { kind: "direct", id: sessionId },
    });

    const { storePath, envelopeOptions, previousTimestamp } = resolveInboundSessionEnvelopeContext({
      cfg: ctx.cfg,
      agentId: route.agentId,
      sessionKey: route.sessionKey,
    });

    const formattedBody = core.channel.reply.formatAgentEnvelope({
      channel: "Shepaw",
      from: userId,
      timestamp: new Date(),
      previousTimestamp,
      envelope: envelopeOptions,
      body,
    });

    // If Shepaw supplied history, prepend it so the AI has context.
    let combinedBody = formattedBody;
    if (history.length > 0 && !params.history_supplement) {
      const historyText = history
        .map((h) => {
          const role = h.role === "user" ? userId : "assistant";
          return core.channel.reply.formatAgentEnvelope({
            channel: "Shepaw",
            from: role,
            envelope: envelopeOptions,
            body: h.content,
          });
        })
        .join("\n");
      combinedBody = `${historyText}\n${formattedBody}`;
    }

    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: combinedBody,
      BodyForAgent: body,
      RawBody: messageText,
      CommandBody: messageText.trim(),
      BodyForCommands: messageText.trim(),
      From: senderFrom,
      To: senderTo,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: "direct" as const,
      ConversationLabel: userId,
      SenderName: userId,
      SenderId: userId,
      Provider: "shepaw" as const,
      Surface: "shepaw" as const,
      MessageSid: params.message_id,
      Timestamp: Date.now(),
      WasMentioned: true,
      CommandAuthorized: true,
      OriginatingChannel: "shepaw" as const,
      OriginatingTo: senderTo,
    });

    await core.channel.session.recordInboundSession({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
      onRecordError: (err) => {
        log.debug?.(`shepaw: failed to record session: ${String(err)}`);
      },
    });

    // Collect streamed reply text so we can send it in chunks.
    // The `deliver` callback is called once with the full finalized payload.
    // We split the text into small chunks to simulate streaming.
    const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
      cfg: ctx.cfg,
      agentId: route.agentId,
      channel: "shepaw",
      accountId: route.accountId,
    });

    let settled = false;
    const markSettled = () => {
      settled = true;
    };

    await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg: ctx.cfg,
      dispatcherOptions: {
        ...prefixOptions,
        deliver: async (payload, _info) => {
          if (abortSignal.aborted) {
            return;
          }

          // `payload` is ReplyPayload — extract the text field.
          const replyPayload = payload as { text?: string; mediaUrl?: string };
          const text = replyPayload.text ?? "";

          if (!text) {
            return;
          }

          // Stream in chunks of ~40 chars to give Shepaw a smooth experience.
          const CHUNK = 40;
          for (let i = 0; i < text.length; i += CHUNK) {
            if (abortSignal.aborted) {
              break;
            }
            send(
              notify("ui.textContent", {
                task_id: taskId,
                content: text.slice(i, i + CHUNK),
                is_final: false,
              }),
            );
            // Yield to the event loop between chunks.
            await new Promise<void>((r) => setTimeout(r, 0));
          }
        },
        onError: (err, info) => {
          log.error(`shepaw: reply dispatch error (${info.kind}): ${String(err)}`);
        },
      },
      replyOptions: {
        onModelSelected,
      },
    });

    if (!settled) {
      markSettled();
    }

    if (!abortSignal.aborted) {
      // Final marker — required by the Shepaw ACP protocol.
      send(notify("ui.textContent", { task_id: taskId, content: "", is_final: true }));
      send(
        notify("task.completed", {
          task_id: taskId,
          status: "success",
          completed_at: nowIso(),
        }),
      );
    }
  } catch (err) {
    if (abortSignal.aborted) {
      send(
        notify("task.error", { task_id: taskId, message: "Task cancelled", code: -32008 }),
      );
    } else {
      log.error(`shepaw: chat handler error: ${String(err)}`);
      send(
        notify("task.error", {
          task_id: taskId,
          message: err instanceof Error ? err.message : String(err),
          code: -32603,
        }),
      );
    }
  }
}
