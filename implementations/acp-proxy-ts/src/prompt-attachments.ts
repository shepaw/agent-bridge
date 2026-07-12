/**
 * Materialize Shepaw `agent.chat` attachments into the agent cwd and build
 * ACP `ContentBlock`s so engines like Cursor actually see images/files.
 *
 * Attachments may arrive as:
 *   - `{ path }` / `{ abs_path }` — preferred for peer (avoids 256KiB ACP frame limit)
 *   - `{ data: base64 }` — small / legacy inline payloads
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ContentBlock } from '@agentclientprotocol/sdk';

export const ATTACHMENTS_DIR = '.shepaw/attachments';

export interface ShepawAttachment {
  fileId?: string;
  fileName: string;
  mimeType: string;
  semanticType: string;
  /** Absolute path already on disk (peer-attachments / host path). */
  sourcePath?: string;
  /** Inline base64 (optional; prefer sourcePath for large files). */
  dataBase64?: string;
  size?: number;
}

export interface MaterializedAttachment {
  absPath: string;
  relativePath: string;
  fileName: string;
  mimeType: string;
  semanticType: string;
  dataBase64: string;
}

export function safeAttachmentLeaf(name: string): string {
  const cleaned = name.replace(/[^\w.\-]+/g, '_');
  if (cleaned.length === 0) return 'file';
  return cleaned.length > 80 ? cleaned.slice(0, 80) : cleaned;
}

function metaFromMap(map: Record<string, unknown>): {
  fileName: string;
  mimeType: string;
  semanticType: string;
  fileId?: string;
  size?: number;
} {
  const fileName =
    (typeof map.file_name === 'string' && map.file_name.length > 0
      ? map.file_name
      : undefined) ??
    (typeof map.fileName === 'string' && map.fileName.length > 0
      ? map.fileName
      : 'file');
  const mimeType =
    (typeof map.mime_type === 'string' && map.mime_type.length > 0
      ? map.mime_type
      : undefined) ??
    (typeof map.mimeType === 'string' && map.mimeType.length > 0
      ? map.mimeType
      : 'application/octet-stream');
  const semanticType =
    (typeof map.type === 'string' && map.type.length > 0 ? map.type : undefined) ??
    (typeof map.file_type === 'string' && map.file_type.length > 0
      ? map.file_type
      : mimeType.startsWith('image/')
        ? 'image'
        : 'file');
  const fileId =
    typeof map.file_id === 'string' && map.file_id.length > 0
      ? map.file_id
      : typeof map.fileId === 'string' && map.fileId.length > 0
        ? map.fileId
        : undefined;
  const size = typeof map.size === 'number' ? map.size : undefined;
  return { fileName, mimeType, semanticType, fileId, size };
}

export function parseShepawAttachments(raw: unknown): ShepawAttachment[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const out: ShepawAttachment[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const map = item as Record<string, unknown>;
    const meta = metaFromMap(map);

    const pathCandidate =
      (typeof map.path === 'string' && map.path.length > 0 ? map.path : undefined) ??
      (typeof map.abs_path === 'string' && map.abs_path.length > 0
        ? map.abs_path
        : undefined) ??
      (typeof map.file_path === 'string' && map.file_path.length > 0
        ? map.file_path
        : undefined);

    const data = typeof map.data === 'string' && map.data.length > 0 ? map.data : undefined;

    if (pathCandidate === undefined && data === undefined) continue;

    out.push({
      ...meta,
      sourcePath: pathCandidate,
      dataBase64: data,
    });
  }
  return out;
}

/** Copy / write attachment bytes under `{cwd}/.shepaw/attachments/`. */
export function materializeAttachments(
  cwd: string,
  attachments: ReadonlyArray<ShepawAttachment>,
): MaterializedAttachment[] {
  if (attachments.length === 0) return [];
  const dir = join(cwd, ATTACHMENTS_DIR);
  mkdirSync(dir, { recursive: true });
  return attachments.map((att, index) => {
    const idPart = att.fileId ? safeAttachmentLeaf(att.fileId) : `att${index}`;
    const leaf = `${idPart}_${safeAttachmentLeaf(att.fileName)}`;
    const absPath = join(dir, leaf);

    if (att.sourcePath !== undefined && existsSync(att.sourcePath)) {
      copyFileSync(att.sourcePath, absPath);
    } else if (att.dataBase64 !== undefined) {
      writeFileSync(absPath, Buffer.from(att.dataBase64, 'base64'));
    } else {
      throw new Error(`Attachment missing path/data: ${att.fileName}`);
    }

    const dataBase64 =
      att.dataBase64 ?? readFileSync(absPath).toString('base64');

    return {
      absPath,
      relativePath: join(ATTACHMENTS_DIR, leaf),
      fileName: att.fileName,
      mimeType: att.mimeType,
      semanticType: att.semanticType,
      dataBase64,
    };
  });
}

function isImage(att: MaterializedAttachment): boolean {
  return att.semanticType === 'image' || att.mimeType.startsWith('image/');
}

/**
 * Build ACP prompt blocks: user text (+ path index) and native image blocks.
 * Non-image files are referenced by absolute path in the text (and resource_link).
 */
export function buildPromptWithAttachments(
  message: string,
  materialized: ReadonlyArray<MaterializedAttachment>,
): ContentBlock[] {
  if (materialized.length === 0) {
    return [{ type: 'text', text: message }];
  }

  const pathLines = materialized.map(
    (m, i) => `- [${i + 1}] ${m.fileName} (${m.mimeType}): ${m.absPath}`,
  );
  const textBody = [
    message.trim().length > 0 ? message : '(see attached files)',
    '',
    'Attached files (saved under the agent working directory):',
    ...pathLines,
  ].join('\n');

  const blocks: ContentBlock[] = [{ type: 'text', text: textBody }];

  for (const m of materialized) {
    if (isImage(m)) {
      blocks.push({
        type: 'image',
        data: m.dataBase64,
        mimeType: m.mimeType,
        uri: `file://${m.absPath}`,
      });
    } else {
      blocks.push({
        type: 'resource_link',
        uri: `file://${m.absPath}`,
        name: m.fileName,
        mimeType: m.mimeType,
      });
    }
  }

  return blocks;
}

/** Parse + materialize + build prompt blocks in one step. */
export function preparePromptFromAttachments(
  cwd: string,
  message: string,
  rawAttachments: unknown,
): { blocks: ContentBlock[]; materialized: MaterializedAttachment[] } {
  const parsed = parseShepawAttachments(rawAttachments);
  const materialized = materializeAttachments(cwd, parsed);
  return {
    blocks: buildPromptWithAttachments(message, materialized),
    materialized,
  };
}
