/**
 * Per-task helper that wraps the raw WebSocket with high-level ACP methods.
 *
 * Wire-compatible with `shepaw_acp_sdk.task_context.TaskContext`.
 *
 * An instance is created for each `agent.chat` invocation and passed to
 * `ACPAgentServer.onChat`. It provides convenient methods so that subclasses
 * never have to build JSON-RPC envelopes by hand.
 */

import { randomUUID } from 'node:crypto';

import type { WebSocket } from 'ws';

import { jsonrpcNotification, jsonrpcRequest } from './jsonrpc.js';
import type { MailboxStreamSink } from './mailbox.js';
import type {
  UIActionOption,
  UIChoiceOption,
  UIFormField,
} from './types.js';

// ── Deferred (Promise with external resolve/reject) ─────────────────

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
  settled: boolean;
}

export function createDeferred<T>(): Deferred<T> {
  // Initialised by the executor below.
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const d: Deferred<T> = {
    promise,
    resolve: (v) => {
      if (!d.settled) {
        d.settled = true;
        resolve(v);
      }
    },
    reject: (e) => {
      if (!d.settled) {
        d.settled = true;
        reject(e);
      }
    },
    settled: false,
  };
  return d;
}

// ── Public option shapes ────────────────────────────────────────────

export interface SendActionConfirmationOpts {
  prompt: string;
  actions: UIActionOption[];
  confirmationId?: string;
  /** Additional fields merged into the notification params. */
  extra?: Record<string, unknown>;
}

export interface SendSingleSelectOpts {
  prompt: string;
  options: UIChoiceOption[];
  selectId?: string;
  extra?: Record<string, unknown>;
}

export interface SendMultiSelectOpts {
  prompt: string;
  options: UIChoiceOption[];
  selectId?: string;
  minSelect?: number;
  maxSelect?: number | null;
  extra?: Record<string, unknown>;
}

export interface SendFileUploadOpts {
  prompt: string;
  uploadId?: string;
  acceptTypes?: string[];
  maxFiles?: number;
  maxSizeMb?: number;
  extra?: Record<string, unknown>;
}

export interface SendFormOpts {
  title: string;
  fields: UIFormField[];
  formId?: string;
  description?: string;
  extra?: Record<string, unknown>;
}

export interface SendFileMessageOpts {
  url: string;
  filename: string;
  mimeType?: string;
  size?: number;
  thumbnailBase64?: string;
  extra?: Record<string, unknown>;
}

export interface SendMessageMetadataOpts {
  collapsible?: boolean;
  collapsibleTitle?: string;
  autoCollapse?: boolean;
  extra?: Record<string, unknown>;
}

export interface WaitForResponseOpts {
  /**
   * Cap on how long to block for a reply. `0` (or `Infinity`) disables the
   * cap entirely: the waiter stays live until the reply arrives, the task is
   * cancelled (waiter rejected with TaskCancelledError), or the connection/
   * process is torn down. Defaults to 300_000 (5 minutes) when omitted.
   */
  timeoutMs?: number;
}

export interface HubRequestOpts {
  timeoutMs?: number;
}

// ── TaskContext ─────────────────────────────────────────────────────

export interface TaskContextInit {
  ws: WebSocket;
  taskId: string;
  sessionId: string;
  pendingHubRequests: Map<string, Deferred<unknown>>;
  pendingResponses: Map<string, Deferred<Record<string, unknown>>>;
  /** Optional early-submitResponse buffer shared with the server. */
  earlyResponses?: Map<string, Record<string, unknown>>;
  takeEarlyResponse?: (componentId: string) => Record<string, unknown> | undefined;
  /**
   * Offline / mailbox mode: when set, `sendText` appends here and lifecycle
   * notifications are no-ops (no live caller WebSocket).
   */
  offlineSink?: { texts: string[] };
  /**
   * Inbox stream mode: each `sendText` delta is sealed into the cloud mailbox
   * for the caller to poll (typewriter while offline from live WS).
   */
  mailboxStream?: MailboxStreamSink;
  /**
   * When set, ALL outbound messages go through this instead of wsSend(ws).
   * The server uses it to route via a re-bindable live connection and to tap
   * replayable events into a per-task buffer, so a client that reconnects
   * after a flap (or a hub restart) can resume the turn via `agent.taskResume`
   * instead of losing it. The transport MUST NOT throw on send failure —
   * a dead route just means "detached, buffer only".
   */
  transport?: (message: Record<string, unknown>) => Promise<void>;
}

export class TaskContext {
  readonly taskId: string;
  readonly sessionId: string;
  private readonly ws: WebSocket;
  private readonly pendingHubRequests: Map<string, Deferred<unknown>>;
  private readonly pendingResponses: Map<string, Deferred<Record<string, unknown>>>;
  private readonly takeEarlyResponse?: (componentId: string) => Record<string, unknown> | undefined;
  private readonly offlineSink?: { texts: string[] };
  private readonly mailboxStream?: MailboxStreamSink;
  private readonly transport?: (message: Record<string, unknown>) => Promise<void>;

  constructor(init: TaskContextInit) {
    this.ws = init.ws;
    this.taskId = init.taskId;
    this.sessionId = init.sessionId;
    this.pendingHubRequests = init.pendingHubRequests;
    this.pendingResponses = init.pendingResponses;
    this.takeEarlyResponse = init.takeEarlyResponse;
    this.offlineSink = init.offlineSink;
    this.mailboxStream = init.mailboxStream;
    this.transport = init.transport;
  }

  /** Collected assistant text in offline/mailbox mode (empty string online). */
  get collectedText(): string {
    if (this.mailboxStream !== undefined) {
      return this.mailboxStream.texts.join('');
    }
    return this.offlineSink?.texts.join('') ?? '';
  }

  // ── Streaming text ────────────────────────────────────────────

  async sendText(content: string): Promise<void> {
    if (this.mailboxStream !== undefined) {
      // depositChunk is the sole collector for `texts` — do not push here
      // or collectedText / depositFinal will duplicate every delta.
      await this.mailboxStream.depositChunk(content);
      return;
    }
    if (this.offlineSink !== undefined) {
      this.offlineSink.texts.push(content);
      return;
    }
    await this.sendRaw(
      jsonrpcNotification('ui.textContent', {
        task_id: this.taskId,
        content,
        is_final: false,
      }),
    );
  }

  async sendTextFinal(): Promise<void> {
    if (this.mailboxStream !== undefined || this.offlineSink !== undefined) return;
    await this.sendRaw(
      jsonrpcNotification('ui.textContent', {
        task_id: this.taskId,
        content: '',
        is_final: true,
      }),
    );
  }

  // ── Task lifecycle ────────────────────────────────────────────

  async started(): Promise<void> {
    if (this.mailboxStream !== undefined || this.offlineSink !== undefined) return;
    await this.sendRaw(
      jsonrpcNotification('task.started', {
        task_id: this.taskId,
        started_at: new Date().toISOString(),
      }),
    );
  }

  async completed(): Promise<void> {
    if (this.mailboxStream !== undefined || this.offlineSink !== undefined) return;
    await this.sendRaw(
      jsonrpcNotification('task.completed', {
        task_id: this.taskId,
        status: 'success',
        completed_at: new Date().toISOString(),
      }),
    );
  }

  async error(message: string, code = -32603): Promise<void> {
    if (this.mailboxStream !== undefined || this.offlineSink !== undefined) return;
    await this.sendRaw(
      jsonrpcNotification('task.error', {
        task_id: this.taskId,
        message,
        code,
      }),
    );
  }

  // ── UI interactive components ─────────────────────────────────
  //
  // These methods are all fire-and-forget: they send a `ui.*` notification
  // and return the component id immediately. The agent's current `onChat`
  // turn should end normally (via `sendTextFinal` + `task.completed`); the
  // user's reply arrives **later as a new `agent.chat` message** which
  // re-enters `onChat`.
  //
  // For the legacy "wait inside the same turn" behaviour, see the
  // `waitForResponse` method below (deprecated).

  private get isSealedTransport(): boolean {
    return this.mailboxStream !== undefined || this.offlineSink !== undefined;
  }

  async sendActionConfirmation(opts: SendActionConfirmationOpts): Promise<string> {
    const cid = opts.confirmationId ?? `confirm_${randomUUID().slice(0, 8)}`;
    if (this.isSealedTransport) {
      const labels = opts.actions.map((a) => a.label || a.value).join(' / ');
      await this.sendText(
        `[需要确认] ${opts.prompt}\n选项：${labels}\n（信箱模式无法展示交互卡片，请在下次在线会话中处理）`,
      );
      return cid;
    }
    await this.sendRaw(
      jsonrpcNotification('ui.actionConfirmation', {
        ...(opts.extra ?? {}),
        task_id: this.taskId,
        confirmation_id: cid,
        prompt: opts.prompt,
        actions: opts.actions,
      }),
    );
    return cid;
  }

  /**
   * @deprecated Use `sendForm` with a `radio_group` field instead. This
   * method is kept for backward compatibility and internally forwards to
   * `sendForm`.
   */
  async sendSingleSelect(opts: SendSingleSelectOpts): Promise<string> {
    return this.sendForm({
      title: opts.prompt,
      fields: [
        {
          name: 'choice',
          label: opts.prompt,
          type: 'radio_group',
          required: true,
          options: opts.options,
        },
      ],
      formId: opts.selectId,
      ...(opts.extra !== undefined ? { extra: opts.extra } : {}),
    });
  }

  /**
   * @deprecated Use `sendForm` with a `checkbox_group` field instead. This
   * method is kept for backward compatibility and internally forwards to
   * `sendForm`.
   */
  async sendMultiSelect(opts: SendMultiSelectOpts): Promise<string> {
    return this.sendForm({
      title: opts.prompt,
      fields: [
        {
          name: 'choices',
          label: opts.prompt,
          type: 'checkbox_group',
          required: (opts.minSelect ?? 1) > 0,
          options: opts.options,
        },
      ],
      formId: opts.selectId,
      ...(opts.extra !== undefined ? { extra: opts.extra } : {}),
    });
  }

  async sendFileUpload(opts: SendFileUploadOpts): Promise<string> {
    const uid = opts.uploadId ?? `upload_${randomUUID().slice(0, 8)}`;
    if (this.isSealedTransport) {
      await this.sendText(
        `[需要上传文件] ${opts.prompt}\n（信箱模式无法展示上传组件，请在下次在线会话中处理）`,
      );
      return uid;
    }
    await this.sendRaw(
      jsonrpcNotification('ui.fileUpload', {
        ...(opts.extra ?? {}),
        task_id: this.taskId,
        upload_id: uid,
        prompt: opts.prompt,
        accept_types: opts.acceptTypes ?? [],
        max_files: opts.maxFiles ?? 5,
        max_size_mb: opts.maxSizeMb ?? 20,
      }),
    );
    return uid;
  }

  async sendForm(opts: SendFormOpts): Promise<string> {
    const fid = opts.formId ?? `form_${randomUUID().slice(0, 8)}`;
    if (this.isSealedTransport) {
      const fields = opts.fields.map((f) => f.label || f.name).join('、');
      await this.sendText(
        `[需要填写表单] ${opts.title}${fields.length > 0 ? `：${fields}` : ''}\n（信箱模式无法展示表单，请在下次在线会话中处理）`,
      );
      return fid;
    }
    await this.sendRaw(
      jsonrpcNotification('ui.form', {
        ...(opts.extra ?? {}),
        task_id: this.taskId,
        form_id: fid,
        title: opts.title,
        description: opts.description ?? '',
        fields: opts.fields,
      }),
    );
    return fid;
  }

  async sendFileMessage(opts: SendFileMessageOpts): Promise<void> {
    if (this.isSealedTransport) {
      await this.sendText(`[文件] ${opts.filename}${opts.url ? ` ${opts.url}` : ''}`);
      return;
    }
    const params: Record<string, unknown> = {
      ...(opts.extra ?? {}),
      task_id: this.taskId,
      url: opts.url,
      filename: opts.filename,
      mime_type: opts.mimeType ?? 'application/octet-stream',
      size: opts.size ?? 0,
    };
    if (opts.thumbnailBase64 !== undefined) {
      params.thumbnail_base64 = opts.thumbnailBase64;
    }
    await this.sendRaw(jsonrpcNotification('ui.fileMessage', params));
  }

  async sendMessageMetadata(opts: SendMessageMetadataOpts = {}): Promise<void> {
    if (this.isSealedTransport) return;
    await this.sendRaw(
      jsonrpcNotification('ui.messageMetadata', {
        ...(opts.extra ?? {}),
        task_id: this.taskId,
        collapsible: opts.collapsible ?? true,
        collapsible_title: opts.collapsibleTitle ?? 'Details',
        auto_collapse: opts.autoCollapse ?? true,
      }),
    );
  }

  // ── Hub requests (Agent → App) ────────────────────────────────

  /**
   * Send a JSON-RPC request to the Shepaw app and wait for the response.
   * Throws `Error` on error or timeout.
   */
  async hubRequest<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    opts: HubRequestOpts = {},
  ): Promise<T> {
    if (this.mailboxStream !== undefined || this.offlineSink !== undefined) {
      throw new Error('hubRequest is unavailable in mailbox/offline mode');
    }
    const reqId = randomUUID();
    const req = jsonrpcRequest(method, params, reqId);
    const deferred = createDeferred<unknown>();
    this.pendingHubRequests.set(reqId, deferred);
    try {
      await this.sendRaw(req);
      return (await withTimeout(deferred.promise, opts.timeoutMs ?? 10_000, `hub.${method}`)) as T;
    } finally {
      this.pendingHubRequests.delete(reqId);
    }
  }

  /**
   * Wait inside the current turn for an interactive response.
   *
   * @deprecated Do NOT use for human-in-the-loop flows that may take more
   * than a few seconds. The recommended pattern is:
   *
   *   1. Call one of the `send*` methods above (fire-and-forget).
   *   2. Finish the current `onChat` turn normally.
   *   3. The user's reply arrives as a regular `agent.chat` message that
   *      re-enters `onChat`; handle it there.
   *
   * Retained for niche use-cases where the agent really does want to block
   * the current turn on a response (e.g. an in-process UI test harness, or a
   * synchronous ACP `request_permission` that MUST block until the reviewer
   * answers). For those, pass `timeoutMs: 0` so a slow human review is not
   * silently turned into a denial; the waiter is released when the task is
   * cancelled (`handleCancelTask` rejects all pending waiters) or torn down.
   */
  async waitForResponse(
    componentId: string,
    opts: WaitForResponseOpts = {},
  ): Promise<Record<string, unknown>> {
    if (this.mailboxStream !== undefined || this.offlineSink !== undefined) {
      throw new Error('interactive wait is unavailable in mailbox/offline mode');
    }
    // Register the waiter FIRST, then consume any early reply. Reversing
    // these races with peer loopback submitResponse and drops the verdict.
    const deferred = createDeferred<Record<string, unknown>>();
    this.pendingResponses.set(componentId, deferred);
    const early = this.takeEarlyResponse?.(componentId);
    if (early !== undefined) {
      deferred.resolve(early);
    }
    try {
      const timeoutMs = opts.timeoutMs;
      // timeoutMs: 0 / Infinity = wait for the reply (or task teardown)
      // without an artificial deadline — see WaitForResponseOpts.
      if (timeoutMs === 0 || timeoutMs === Infinity) {
        return await deferred.promise;
      }
      return await withTimeout(deferred.promise, timeoutMs ?? 300_000, `component ${componentId}`);
    } finally {
      this.pendingResponses.delete(componentId);
    }
  }

  // ── internal ──────────────────────────────────────────────────

  private async sendRaw(message: unknown): Promise<void> {
    if (this.transport !== undefined) {
      await this.transport(message as Record<string, unknown>);
      return;
    }
    await wsSend(this.ws, message);
  }
}

// ── helpers ─────────────────────────────────────────────────────────

import type { NoiseSession } from './noise.js';
import { encodeFrame, MAX_FRAME_AGENT_TO_APP } from './envelope.js';

/**
 * WebSocket objects we manage carry an optional NoiseSession used to encrypt
 * outgoing frames once the v2 handshake completes. We attach it as a property
 * on the ws object itself, which is the `ws` library's standard pattern for
 * per-connection state. This keeps `wsSend` stateless w.r.t. connection IDs.
 */
export interface ShepawWebSocket extends WebSocket {
  /**
   * The Noise session for this connection. Present after the handshake
   * completes and used by `wsSend` to encrypt outgoing JSON-RPC messages.
   * Absent means "still in handshake" — `wsSend` will send raw (which should
   * only happen for the handshake response itself; regular JSON-RPC sending
   * after handshake without a session indicates a bug).
   */
  noiseSession?: NoiseSession;
  /**
   * v2.1: the authorized peer entry this connection handshook as. Populated
   * right after `readHandshake1` resolved the peer's static public key and
   * the server matched it against `authorized_peers.json`. Used later when
   * processing `peer.unregister` (the peer identity comes from here, not from
   * untrusted RPC params) and when `reloadPeers()` needs to boot any session
   * whose peer has been revoked from the allowlist.
   */
  authorizedPeer?: import('./peers.js').AuthorizedPeer;
  /**
   * WS close codes in the 4000 range mean "application-level" — setting this
   * flag prevents the server from trying to send further frames on an
   * already-closing connection.
   */
  v2Closing?: boolean;
}

/**
 * Send a JSON-RPC message. If the WS has a ready `NoiseSession` attached,
 * the payload is encrypted into a `data` frame (v2 protocol). Otherwise the
 * message is serialized raw (used only during the v2 handshake preamble).
 */
export async function wsSend(ws: WebSocket, message: unknown): Promise<void> {
  const sws = ws as ShepawWebSocket;
  if (sws.v2Closing === true) {
    // Silently drop — peer was already told we're closing.
    return;
  }
  const json = JSON.stringify(message);
  let payload: string;
  if (sws.noiseSession !== undefined && sws.noiseSession.ready) {
    const ct = sws.noiseSession.encrypt(Buffer.from(json, 'utf-8'));
    if (ct.length > MAX_FRAME_AGENT_TO_APP) {
      // Hard-close rather than silently truncate. Caller is responsible for
      // staying under MAX_FRAME_AGENT_TO_APP per message.
      sws.v2Closing = true;
      try {
        ws.close(4402, 'frame too large');
      } catch {
        /* ignore */
      }
      throw new Error(`wsSend: encrypted frame ${ct.length} exceeds limit`);
    }
    payload = encodeFrame({ t: 'data', payload: ct });
  } else {
    // Pre-handshake — message is already a handshake envelope or a pre-auth
    // error. Emit as-is.
    payload = json;
  }
  await new Promise<void>((resolve, reject) => {
    ws.send(payload, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(`Timed out after ${timeoutMs}ms: ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class TimeoutError extends Error {
  override readonly name = 'TimeoutError';
}
