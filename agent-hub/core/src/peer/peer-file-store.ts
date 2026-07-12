/**
 * In-memory + on-disk store for peer-pushed attachments.
 *
 * Files land under `{hubRoot}/instances/<id>/peer-attachments/`, alongside
 * that instance's identity.json / authorized_peers.json.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { getInstance, loadOrCreateHubConfig } from '../config.js';
import { peerAttachmentsDir } from '../paths.js';

export const MAX_PEER_FILE_BYTES = 20 * 1024 * 1024;

export interface IncomingPeerFile {
  agentId: string;
  fileId: string;
  fileName: string;
  mimeType: string;
  semanticType: string;
  size: number;
  chunks: Map<number, Buffer>;
}

export interface StoredPeerFile {
  agentId: string;
  absPath: string;
  fileName: string;
  mimeType: string;
  semanticType: string;
  size: number;
}

export function safeFileName(name: string): string {
  const cleaned = name.replace(/[^\w.\-]+/g, '_');
  if (cleaned.length === 0) return 'file';
  return cleaned.length > 80 ? cleaned.slice(0, 80) : cleaned;
}

export function normalizePeerAttachmentRefs(
  raw: unknown,
): ReadonlyArray<Record<string, unknown>> | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: Record<string, unknown>[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const map = item as Record<string, unknown>;
    const fileId = map.file_id;
    if (typeof fileId !== 'string' || fileId.length === 0) continue;
    out.push(map);
  }
  return out.length > 0 ? out : undefined;
}

/** Assemble ACP-style attachments (with base64 `data`) from stored file refs. */
export function resolveAttachmentsForAcp(
  agentId: string,
  refs: ReadonlyArray<Record<string, unknown>> | undefined,
  stored: Map<string, StoredPeerFile>,
): Record<string, unknown>[] | undefined {
  if (refs === undefined || refs.length === 0) return undefined;
  const out: Record<string, unknown>[] = [];
  for (const ref of refs) {
    const fileId = ref.file_id as string;
    const entry = stored.get(fileId);
    if (entry === undefined || entry.agentId !== agentId) {
      throw new Error(`Unknown or mismatched attachment file_id: ${fileId}`);
    }
    if (!existsSync(entry.absPath)) {
      throw new Error(`Attachment file missing on host: ${fileId}`);
    }
    const bytes = readFileSync(entry.absPath);
    out.push({
      file_id: fileId,
      file_name: entry.fileName,
      mime_type: entry.mimeType,
      size: entry.size,
      type: entry.semanticType,
      data: bytes.toString('base64'),
    });
  }
  return out;
}

export function persistIncomingFile(
  incoming: IncomingPeerFile,
  chunkCount: number,
): StoredPeerFile {
  if (incoming.chunks.size !== chunkCount) {
    throw new Error(
      `chunk count mismatch: got ${incoming.chunks.size}, expected ${chunkCount}`,
    );
  }
  const parts: Buffer[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const part = incoming.chunks.get(i);
    if (part === undefined) throw new Error(`missing chunk ${i}`);
    parts.push(part);
  }
  const bytes = Buffer.concat(parts);
  if (bytes.length > MAX_PEER_FILE_BYTES) {
    throw new Error('assembled file exceeds size limit');
  }

  const cfg = loadOrCreateHubConfig();
  // Validate instance exists (throws if unknown).
  getInstance(cfg, incoming.agentId);
  const dir = peerAttachmentsDir(incoming.agentId);
  mkdirSync(dir, { recursive: true });
  const leaf = `${safeFileName(incoming.fileId)}_${safeFileName(incoming.fileName)}`;
  const absPath = join(dir, leaf);
  writeFileSync(absPath, bytes);

  return {
    agentId: incoming.agentId,
    absPath,
    fileName: incoming.fileName,
    mimeType: incoming.mimeType,
    semanticType: incoming.semanticType,
    size: bytes.length,
  };
}
