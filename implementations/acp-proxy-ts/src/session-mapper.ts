/**
 * Maps ACP `session/update` notifications to Shepaw TaskContext UI calls.
 */

import type * as acp from '@agentclientprotocol/sdk';
import type { TaskContext } from 'shepaw-acp-sdk';

import { log } from './debug.js';
import { formatPlanText, formatToolCallUpdateText } from './permission/format.js';

/** Stream a final (or buffered) agent answer chunk to the app. */
export async function flushAgentMessage(ctx: TaskContext, text: string): Promise<void> {
  if (text.length === 0) return;
  // End any collapsible thinking/tool section so the answer stays visible
  // while progress is folded into metadata.progress_content on the client.
  await ctx.sendMessageMetadata({
    collapsible: false,
    collapsibleTitle: '',
    autoCollapse: false,
  });
  await ctx.sendText(text);
}

export async function mapSessionUpdate(
  update: acp.SessionUpdate,
  ctx: TaskContext,
): Promise<void> {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const content = update.content;
      if (content.type === 'text' && content.text.length > 0) {
        await flushAgentMessage(ctx, content.text);
      }
      break;
    }

    case 'agent_thought_chunk': {
      const content = update.content;
      if (content.type === 'text' && content.text.length > 0) {
        await ctx.sendMessageMetadata({
          collapsible: true,
          collapsibleTitle: 'Thinking',
          autoCollapse: true,
        });
        await ctx.sendText(content.text);
      }
      break;
    }

    case 'tool_call': {
      const title = update.title ?? update.kind ?? 'Tool';
      await ctx.sendMessageMetadata({
        collapsible: true,
        collapsibleTitle: title,
        autoCollapse: true,
      });
      // Surface enough of the tool call (command, affected files) that a
      // reviewer can follow along — the thin `[status] title` alone hides
      // exactly what the agent is about to do.
      const text = formatToolCallUpdateText(update);
      if (text !== undefined) await ctx.sendText(text);
      break;
    }

    case 'tool_call_update': {
      if (update.status !== undefined) {
        log('tool_call_update %s → %s', update.toolCallId, update.status);
        // After a permission grant, Cursor often only emits status updates
        // (in_progress / completed) — not a fresh agent_message_chunk. Stream
        // those so the phone UI shows progress instead of looking frozen
        // until the next permission card or final text.
        const text = formatToolCallUpdateText(update);
        if (text !== undefined) await ctx.sendText(text);
      }
      break;
    }

    case 'plan': {
      const text = formatPlanText(update);
      if (text !== undefined) {
        await ctx.sendMessageMetadata({
          collapsible: true,
          collapsibleTitle: 'Plan',
          autoCollapse: false,
        });
        await ctx.sendText(text);
      }
      break;
    }

    case 'available_commands_update': {
      // Cached by the agent for onCommandsList; nothing to stream here.
      log('available_commands_update: %d commands', update.availableCommands?.length ?? 0);
      break;
    }

    case 'current_mode_update':
    case 'config_option_update':
    case 'session_info_update':
      log('session meta update: %s', update.sessionUpdate);
      break;

    default:
      log('unhandled session update: %s', (update as { sessionUpdate: string }).sessionUpdate);
      break;
  }
}
