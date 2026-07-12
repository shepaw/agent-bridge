import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { addInstance, loadOrCreateHubConfig, saveHubConfig } from '../src/config.js';
import { peerAttachmentsDir } from '../src/paths.js';
import {
  clearPeerAttachments,
  deletePeerAttachment,
  listPeerAttachments,
  normalizePeerAttachmentRefs,
  persistIncomingFile,
  resolveAttachmentsForAcp,
  safeFileName,
} from '../src/peer/peer-file-store.js';

let home: string;
let prevHome: string | undefined;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'shepaw-peer-files-'));
  cwd = mkdtempSync(join(tmpdir(), 'shepaw-agent-cwd-'));
  prevHome = process.env.SHEPAW_HUB_HOME;
  process.env.SHEPAW_HUB_HOME = home;

  let cfg = loadOrCreateHubConfig();
  cfg = addInstance(cfg, {
    id: 'alpha',
    engine: 'claude-code',
    cwd,
    host: '127.0.0.1',
    port: 18811,
    baseUrl: '',
    extraArgs: [],
  });
  saveHubConfig(cfg.path, cfg);
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.SHEPAW_HUB_HOME;
  else process.env.SHEPAW_HUB_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe('normalizePeerAttachmentRefs', () => {
  it('keeps only objects with file_id', () => {
    expect(normalizePeerAttachmentRefs(undefined)).toBeUndefined();
    expect(normalizePeerAttachmentRefs([])).toBeUndefined();
    expect(
      normalizePeerAttachmentRefs([
        { file_id: 'abc', file_name: 'a.jpg' },
        { file_name: 'no-id' },
        'bad',
      ]),
    ).toEqual([{ file_id: 'abc', file_name: 'a.jpg' }]);
  });
});

describe('persistIncomingFile', () => {
  it('writes under instances/<id>/peer-attachments (next to identity.json)', () => {
    const chunks = new Map<number, Buffer>();
    chunks.set(0, Buffer.from('hello '));
    chunks.set(1, Buffer.from('world'));
    const stored = persistIncomingFile(
      {
        agentId: 'alpha',
        fileId: 'abcd1234efgh',
        fileName: 'note.txt',
        mimeType: 'text/plain',
        semanticType: 'file',
        size: 11,
        chunks,
      },
      2,
    );
    expect(stored.absPath.startsWith(peerAttachmentsDir('alpha'))).toBe(true);
    expect(stored.absPath.includes(join('instances', 'alpha', 'peer-attachments'))).toBe(true);
    expect(readFileSync(stored.absPath, 'utf8')).toBe('hello world');
  });
});

describe('resolveAttachmentsForAcp', () => {
  it('loads bytes as base64 for ACP', () => {
    const chunks = new Map<number, Buffer>();
    chunks.set(0, Buffer.from('img'));
    const stored = persistIncomingFile(
      {
        agentId: 'alpha',
        fileId: 'fileid000001',
        fileName: 'a.png',
        mimeType: 'image/png',
        semanticType: 'image',
        size: 3,
        chunks,
      },
      1,
    );
    const map = new Map([['fileid000001', stored]]);
    const acp = resolveAttachmentsForAcp(
      'alpha',
      [{ file_id: 'fileid000001' }],
      map,
    );
    expect(acp).toHaveLength(1);
    expect(acp![0].data).toBe(Buffer.from('img').toString('base64'));
    expect(acp![0].type).toBe('image');
  });
});

describe('safeFileName', () => {
  it('strips unsafe characters', () => {
    expect(safeFileName('../a b.png')).toBe('.._a_b.png');
  });
});

describe('list/delete/clear peer attachments', () => {
  it('lists persisted files and supports delete + clear', () => {
    const persist = (fileId: string, fileName: string, body: string) => {
      const chunks = new Map<number, Buffer>();
      chunks.set(0, Buffer.from(body));
      return persistIncomingFile(
        {
          agentId: 'alpha',
          fileId,
          fileName,
          mimeType: 'text/plain',
          semanticType: 'file',
          size: body.length,
          chunks,
        },
        1,
      );
    };

    persist('id111', 'one.txt', 'one');
    persist('id222', 'two.txt', 'two');

    const listed = listPeerAttachments('alpha');
    expect(listed).toHaveLength(2);
    expect(listed.map((a) => a.fileName).sort()).toEqual(['one.txt', 'two.txt']);
    expect(listed.every((a) => a.size > 0 && a.modifiedAt.length > 0)).toBe(true);

    const target = listed.find((a) => a.fileName === 'one.txt')!;
    expect(deletePeerAttachment('alpha', target.name)).toBe(true);
    expect(listPeerAttachments('alpha')).toHaveLength(1);
    expect(deletePeerAttachment('alpha', target.name)).toBe(false);

    expect(clearPeerAttachments('alpha')).toBe(1);
    expect(listPeerAttachments('alpha')).toEqual([]);
    expect(clearPeerAttachments('alpha')).toBe(0);
  });
});
