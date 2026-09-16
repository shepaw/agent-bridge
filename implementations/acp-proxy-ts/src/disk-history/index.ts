/**
 * Disk-first session history loaders.
 *
 * When an engine persists per-message timestamps on disk, read them directly
 * and map into the standard Shepaw `SessionHistoryMessage` shape (with
 * `created_at`). Callers fall back to ACP `session/load` when this returns null.
 */

import { loadClaudeCodeHistory } from './claude-code.js';
import { loadCodebuddyHistory } from './codebuddy.js';
import { loadHermesHistory } from './hermes.js';
import type { DiskHistoryMessage } from './util.js';

export type { DiskHistoryMessage };

export async function tryLoadDiskHistory(
  engineId: string,
  sessionId: string,
  cwd: string,
): Promise<DiskHistoryMessage[] | null> {
  if (sessionId.length === 0) return null;

  switch (engineId) {
    case 'claude-code':
    case 'tclaude':
    case 'claude-internal':
      return loadClaudeCodeHistory(sessionId, cwd);
    case 'codebuddy':
      return loadCodebuddyHistory(sessionId, cwd);
    case 'codex':
    case 'tcodex':
    case 'opencode':
    case 'openclaw':
      // Manual Hub sync manifest gates list/history; do not auto-read disk here.
      return null;
    case 'hermes':
      return loadHermesHistory(sessionId);
    case 'cursor':
      // Cursor has no durable per-message timestamps on disk for assistant
      // turns; keep using session/load + embedded <timestamp> extraction.
      return null;
    default:
      return null;
  }
}
