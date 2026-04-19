/**
 * Utility helpers for the Shepaw ACP protocol.
 *
 * Wire-compatible with `shepaw_acp_sdk.utils`.
 */

import { jsonrpcNotification } from './jsonrpc.js';
import type { ACPDirective, JsonRpcNotification } from './types.js';

/**
 * Convert an `ACPDirective` into a JSON-RPC `ui.*` notification.
 *
 * Looks up the directive type in `componentMethodMap` (typically obtained
 * from the app via `hub.getUIComponentTemplates`) so the app defines the
 * schema and the agent is a pass-through. Injects `task_id` into the
 * forwarded payload.
 *
 * Unknown directive types fall back to a `ui.textContent` notification
 * with a placeholder message, matching the Python implementation.
 */
export function acpDirectiveToNotification(
  directive: ACPDirective,
  taskId: string,
  componentMethodMap: Readonly<Record<string, string>> = {},
): JsonRpcNotification {
  const method = componentMethodMap[directive.directiveType];

  if (method === undefined) {
    return jsonrpcNotification('ui.textContent', {
      task_id: taskId,
      content: `[Unknown directive: ${directive.directiveType}]`,
      is_final: false,
    });
  }

  return jsonrpcNotification(method, {
    ...directive.payload,
    task_id: taskId,
  });
}
