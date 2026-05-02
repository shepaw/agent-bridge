/**
 * Scan agent-owned directories for slash-command markdown files and parse
 * their YAML-ish frontmatter.
 *
 * The directory layout is owned by the concrete agent (e.g. ClaudeCodeAgent
 * points at `.claude/commands/` plus `~/.claude/commands/`). This module is
 * agent-agnostic — it just reads a directory and returns `SlashCommandInfo`
 * entries tagged with whatever `scope` the caller chose.
 *
 * Frontmatter parsing is deliberately minimal: we look for a leading
 * `---\n...\n---` block and parse the inner lines as `key: value` pairs.
 * That covers the shape documented by Claude Code (`description`,
 * `argument-hint`, `model`, `allowed-tools`) without pulling in a real YAML
 * library. If we ever need nested structures here we can swap in `yaml`.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import type { CommandScope, SlashCommandInfo } from './types.js';

// Minimal debug log — avoids pulling in the impl-specific `debug` package.
// Enable at runtime via DEBUG=shepaw:scanner or similar; for now we just use
// console.debug which is silent in most runners.
const log = {
  gateway(fmt: string, ...args: unknown[]) {
    if (process.env.DEBUG && /shepaw|scanner/.test(process.env.DEBUG)) {
      // eslint-disable-next-line no-console
      console.debug(`[commands-scanner] ${fmt}`, ...args);
    }
  },
};

/** Entries a frontmatter block can carry that we surface on the wire. */
interface Frontmatter {
  description?: string;
  argument_hint?: string;
}

/**
 * Parse the leading `---\n...\n---` YAML-ish block of a markdown file.
 *
 * Returns `null` if the file doesn't start with a frontmatter fence. Unknown
 * keys are ignored. Only string values are supported — that's all Claude Code
 * uses in practice.
 */
export function parseFrontmatter(source: string): Frontmatter | null {
  if (!source.startsWith('---\n') && !source.startsWith('---\r\n')) return null;
  const afterOpen = source.replace(/^---\r?\n/, '');
  const closeIdx = afterOpen.search(/\r?\n---(\r?\n|$)/);
  if (closeIdx === -1) return null;
  const block = afterOpen.slice(0, closeIdx);
  const out: Frontmatter = {};
  for (const raw of block.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    // Strip surrounding quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value === '') continue;
    // Accept both snake-case and kebab-case / camelCase inputs, normalize to
    // the wire field names.
    switch (key) {
      case 'description':
        out.description = value;
        break;
      case 'argument-hint':
      case 'argument_hint':
      case 'argumentHint':
        out.argument_hint = value;
        break;
      default:
        // other known-but-unused keys (model, allowed-tools, …) silently ignored
        break;
    }
  }
  return out;
}

/**
 * Walk `dir` recursively, emit one `SlashCommandInfo` per `.md` file.
 *
 * - Command `name` = path from `dir` to file, without `.md`, with path
 *   separators replaced by `:` (matches Claude Code's `deploy:staging`
 *   namespacing for subdirectories).
 * - Missing / unreadable directories return `[]`; per-file failures are
 *   logged at debug level and skipped.
 * - `source` is always `'filesystem'`. `scope` is whatever the caller chose.
 */
export async function scanCommandsDir(
  dir: string,
  scope: CommandScope,
): Promise<SlashCommandInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(dir, { recursive: true });
  } catch (err) {
    // ENOENT is normal — user just doesn't have this directory.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.gateway(
        'commands-scanner: readdir %s failed: %s',
        dir,
        (err as Error).message,
      );
    }
    return [];
  }

  const out: SlashCommandInfo[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const absPath = join(dir, entry);
    const rel = relative(dir, absPath);
    const name = rel.slice(0, -'.md'.length).split(sep).join(':');
    if (name === '') continue;
    try {
      const source = await readFile(absPath, 'utf-8');
      const fm = parseFrontmatter(source);
      out.push({
        name,
        description: fm?.description,
        argument_hint: fm?.argument_hint,
        scope,
        source: 'filesystem',
      });
    } catch (err) {
      log.gateway(
        'commands-scanner: skipping %s: %s',
        absPath,
        (err as Error).message,
      );
    }
  }
  return out;
}
