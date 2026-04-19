/**
 * JSON-RPC 2.0 message builders for the Shepaw ACP protocol.
 *
 * Wire-compatible with the Python `shepaw_acp_sdk.jsonrpc` module.
 */

import { randomUUID } from 'node:crypto';

import type {
  JsonRpcErrorObject,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from './types.js';

/** Build a JSON-RPC 2.0 response (success or error). */
export function jsonrpcResponse(
  id: string | number | null,
  args: { result?: unknown; error?: JsonRpcErrorObject } = {},
): JsonRpcResponse {
  if (args.error !== undefined) {
    return { jsonrpc: '2.0', id, error: args.error };
  }
  // Python defaults to `{}` when result is not provided — match that.
  return {
    jsonrpc: '2.0',
    id,
    result: args.result !== undefined && args.result !== null ? args.result : {},
  };
}

/** Build a JSON-RPC 2.0 notification (no id). */
export function jsonrpcNotification(
  method: string,
  params?: Record<string, unknown>,
): JsonRpcNotification {
  const msg: JsonRpcNotification = { jsonrpc: '2.0', method };
  if (params !== undefined) msg.params = params;
  return msg;
}

/** Build a JSON-RPC 2.0 request. If `id` is omitted, a random UUID v4 is assigned. */
export function jsonrpcRequest(
  method: string,
  params?: Record<string, unknown>,
  id?: string | number,
): JsonRpcRequest {
  const msg: JsonRpcRequest = {
    jsonrpc: '2.0',
    method,
    id: id !== undefined ? id : randomUUID(),
  };
  if (params !== undefined) msg.params = params;
  return msg;
}
