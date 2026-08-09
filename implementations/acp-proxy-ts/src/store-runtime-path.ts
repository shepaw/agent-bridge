/**
 * Runtime artifact path helpers — mirror App RuntimePaths / ArtifactService.
 *
 * New product writes:
 *   runtime/<owner>/<channel>/[wf_<wf>__step_<step>/]artifacts/<task>/<file>
 *
 * Legacy `artifacts` space keeps `<task>/<file>`.
 */

export const WORKFLOW_SCOPE_MARKER = '__wf_';

/** Sanitize one path segment (aligned with Dart RuntimePaths.sanitizeSegment). */
export function sanitizeStoreSegment(raw: string): string {
  const s = raw.trim();
  if (!s) return '_default';
  return s
    .replace(/[/\\]+/g, '_')
    .replace(/\.\./g, '_')
    .replace(/[^\w.\-@+]/g, '_');
}

/** Basename only — reject path traversal in filenames. */
export function safeStoreFilename(filename: string): string {
  const parts = filename.replace(/\\/g, '/').split('/');
  const base = parts[parts.length - 1] ?? filename;
  const cleaned = base.trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    return 'file';
  }
  return cleaned;
}

/** Split `channel__wf_x__step_y` → channel + `wf_x__step_y`. */
export function splitChannelId(raw: string): {
  channelId: string;
  workflowScope?: string;
} {
  const i = raw.indexOf(WORKFLOW_SCOPE_MARKER);
  if (i <= 0) return { channelId: raw };
  return {
    channelId: raw.slice(0, i),
    workflowScope: raw.slice(i + 2),
  };
}

export interface ArtifactPathInput {
  space: string;
  filename: string;
  /** Task folder; default `general`. */
  task?: string;
  /** runtime owner (agent / group). */
  owner?: string;
  /** runtime channel / session id (may include `__wf_…__step_…`). */
  channel?: string;
}

/**
 * Build the store-relative path (no space / device prefix).
 */
export function buildArtifactRelPath(input: ArtifactPathInput): string {
  const space = input.space.trim() || 'runtime';
  const filename = safeStoreFilename(input.filename);
  const task = sanitizeStoreSegment(input.task ?? 'general');

  if (space === 'runtime') {
    const owner = sanitizeStoreSegment(
      input.owner?.trim() || input.channel?.trim() || 'default',
    );
    const channelRaw =
      (input.channel?.trim() || input.owner?.trim() || owner).trim() || owner;
    const { channelId, workflowScope } = splitChannelId(channelRaw);
    const ch = sanitizeStoreSegment(channelId);
    const root = workflowScope
      ? `${owner}/${ch}/${sanitizeStoreSegment(workflowScope)}`
      : `${owner}/${ch}`;
    return `${root}/artifacts/${task}/${filename}`;
  }

  // Legacy artifacts + simple spaces: task/filename (CLI always sets task).
  if (space === 'artifacts') {
    return `${task}/${filename}`;
  }

  // files / public / others: optional task prefix; allow nested filename paths
  // only when caller passed an explicit relative path without task (legacy).
  if (input.task) {
    return `${task}/${filename}`;
  }
  const raw = input.filename.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!raw || raw.split('/').includes('..')) {
    return filename;
  }
  return raw;
}

/** Markdown share line: `[name](store://…)`. */
export function formatStoreMarkdownLink(
  displayName: string,
  storeUri: string,
): string {
  return `[${displayName}](${storeUri})`;
}
