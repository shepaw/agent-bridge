/**
 * Disk-first session history loaders.
 *
 * When an engine persists per-message timestamps on disk, read them directly
 * and map into the standard Shepaw `SessionHistoryMessage` shape (with
 * `created_at`). Callers fall back to ACP `session/load` when this returns null.
 */

import { loadClaudeCodeHistory } from './claude-code.js';
import { loadCodebuddyHistory, loadOpenclawHistory } from './codebuddy.js';
import { loadCodexHistory } from './codex.js';
import { loadHermesHistory } from './hermes.js';
import { loadOpencodeHistory } from './opencode.js';
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
      return loadClaudeCodeHistory(sessionId, cwd);
    case 'codebuddy':
      return loadCodebuddyHistory(sessionId, cwd);
    case 'codex':
      return loadCodexHistory(sessionId);
    case 'opencode':
      return loadOpencodeHistory(sessionId);
    case 'openclaw':
      return loadOpenclawHistory(sessionId);
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
