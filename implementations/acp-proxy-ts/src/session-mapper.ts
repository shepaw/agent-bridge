/**
 * Maps ACP `session/update` notifications to Shepaw TaskContext UI calls.
 */

import type * as acp from '@agentclientprotocol/sdk';
import type { TaskContext } from 'shepaw-acp-sdk';

import { log } from './debug.js';
import { extractCommand, extractPaths } from './permission/format.js';

export async function mapSessionUpdate(
  update: acp.SessionUpdate,
  ctx: TaskContext,
): Promise<void> {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const content = update.content;
      if (content.type === 'text' && content.text.length > 0) {
        await ctx.sendText(content.text);
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
      const lines = [`[${update.status}] ${title}`];
      const command = extractCommand(update);
      if (command.length > 0 && command !== title) {
        lines.push('```', command.slice(0, 2000), '```');
      }
      const paths = extractPaths(update);
      if (paths.length > 0) {
        lines.push(`Files: ${paths.slice(0, 12).join(', ')}${paths.length > 12 ? ' …' : ''}`);
      }
      await ctx.sendText(`${lines.join('\n')}\n`);
      break;
    }

    case 'tool_call_update': {
      if (update.status !== undefined) {
        log('tool_call_update %s → %s', update.toolCallId, update.status);
        // After a permission grant, Cursor often only emits status updates
        // (in_progress / completed) — not a fresh agent_message_chunk. Stream
        // those so the phone UI shows progress instead of looking frozen
        // until the next permission card or final text.
        const title = update.title ?? update.kind ?? update.toolCallId ?? 'Tool';
        const lines = [`[${update.status}] ${title}`];
        const command = extractCommand(update);
        if (command.length > 0 && command !== title) {
          lines.push('```', command.slice(0, 2000), '```');
        }
        const paths = extractPaths(update);
        if (paths.length > 0) {
          lines.push(`Files: ${paths.slice(0, 12).join(', ')}${paths.length > 12 ? ' …' : ''}`);
        }
        await ctx.sendText(`${lines.join('\n')}\n`);
      }
      break;
    }

    case 'plan': {
      const entries = update.entries ?? [];
      if (entries.length > 0) {
        await ctx.sendMessageMetadata({
          collapsible: true,
          collapsibleTitle: 'Plan',
          autoCollapse: false,
        });
        const lines = entries.map((e, i) => `${i + 1}. ${e.content ?? ''}`);
        await ctx.sendText(`${lines.join('\n')}\n`);
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
