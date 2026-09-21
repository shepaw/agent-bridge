/**
 * `shepaw-hub analyze` — post-hoc token + tool statistics over finished
 * session transcripts. Purely offline: it reads what is already on disk.
 */

import { writeFile } from 'node:fs/promises';

import {
  claudeProjectSlug,
  getInstance,
  loadOrCreateHubConfig,
  runAnalyze,
  type AnalyzeFilters,
} from '@shepaw/agent-hub-core';

export interface AnalyzeCommandOptions {
  session?: string;
  workspace?: string;
  instance?: string;
  engine?: string;
  since?: string;
  until?: string;
  json?: boolean;
  out?: string;
}

/** Validate an ISO-8601 option so a typo fails loudly instead of matching nothing. */
function isoOrThrow(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid ${flag}: "${value}" is not a parseable ISO-8601 timestamp.`);
  }
  return new Date(ms).toISOString();
}

/**
 * Resolve `--instance <id>` to its working directory.
 *
 * The filter is applied as a workspace path rather than an instance id: the
 * transcripts record a cwd, never a hub instance id, and several instances may
 * legitimately share one cwd.
 */
function workspaceForInstance(id: string): string {
  const cfg = loadOrCreateHubConfig();
  const instance = getInstance(cfg, id);
  return claudeProjectSlug(instance.cwd);
}

export async function runAnalyzeCommand(options: AnalyzeCommandOptions): Promise<number> {
  const filters: AnalyzeFilters = {};
  if (options.session !== undefined) filters.session = options.session;
  if (options.engine !== undefined) filters.engine = options.engine;

  const since = isoOrThrow(options.since, '--since');
  const until = isoOrThrow(options.until, '--until');
  if (since !== undefined) filters.since = since;
  if (until !== undefined) filters.until = until;

  if (options.workspace !== undefined) filters.workspace = options.workspace;
  if (options.instance !== undefined) {
    filters.instance = options.instance;
    // An explicit --workspace wins; --instance is the fallback mapping.
    if (options.workspace === undefined) filters.workspace = workspaceForInstance(options.instance);
  }

  const wantsJson = options.json === true || options.out?.endsWith('.json') === true;
  const result = await runAnalyze({ ...filters, json: wantsJson });

  if (options.out !== undefined) {
    await writeFile(options.out, result.text, 'utf-8');
    process.stdout.write(`Wrote ${result.scan.stats.requests.toLocaleString('en-US')} requests → ${options.out}\n`);
  } else {
    process.stdout.write(result.text);
  }

  if (result.scan.stats.requests === 0) {
    process.stderr.write('No matching requests found. Widen the filters or check the transcript roots.\n');
    return 1;
  }
  return 0;
}
