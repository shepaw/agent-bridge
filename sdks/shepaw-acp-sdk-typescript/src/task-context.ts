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
}

export class TaskContext {
  readonly taskId: string;
  readonly sessionId: string;
  private readonly ws: WebSocket;
  private readonly pendingHubRequests: Map<string, Deferred<unknown>>;
  private readonly pendingResponses: Map<string, Deferred<Record<string, unknown>>>;

  constructor(init: TaskContextInit) {
    this.ws = init.ws;
    this.taskId = init.taskId;
    this.sessionId = init.sessionId;
    this.pendingHubRequests = init.pendingHubRequests;
    this.pendingResponses = init.pendingResponses;
  }

  // ── Streaming text ────────────────────────────────────────────

  async sendText(content: string): Promise<void> {
    await this.sendRaw(
      jsonrpcNotification('ui.textContent', {
        task_id: this.taskId,
        content,
        is_final: false,
      }),
    );
  }

  async sendTextFinal(): Promise<void> {
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
    await this.sendRaw(
      jsonrpcNotification('task.started', {
        task_id: this.taskId,
        started_at: new Date().toISOString(),
      }),
    );
  }

  async completed(): Promise<void> {
    await this.sendRaw(
      jsonrpcNotification('task.completed', {
        task_id: this.taskId,
        status: 'success',
        completed_at: new Date().toISOString(),
      }),
    );
  }

  async error(message: string, code = -32603): Promise<void> {
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

  async sendActionConfirmation(opts: SendActionConfirmationOpts): Promise<string> {
    const cid = opts.confirmationId ?? `confirm_${randomUUID().slice(0, 8)}`;
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
   * This method is retained for niche use-cases where the agent really
   * does want to block the current turn on a response (e.g. an in-process
   * UI test harness). It still obeys the 300-second timeout.
   */
  async waitForResponse(
    componentId: string,
    opts: WaitForResponseOpts = {},
  ): Promise<Record<string, unknown>> {
    const deferred = createDeferred<Record<string, unknown>>();
    this.pendingResponses.set(componentId, deferred);
    try {
      return await withTimeout(deferred.promise, opts.timeoutMs ?? 300_000, `component ${componentId}`);
    } finally {
      this.pendingResponses.delete(componentId);
    }
  }

  // ── internal ──────────────────────────────────────────────────

  private async sendRaw(message: unknown): Promise<void> {
    await wsSend(this.ws, message);
  }
}

// ── helpers ─────────────────────────────────────────────────────────

export async function wsSend(ws: WebSocket, message: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ws.send(JSON.stringify(message), (err) => {
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
