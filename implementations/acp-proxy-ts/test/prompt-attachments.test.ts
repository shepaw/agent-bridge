import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  INLINE_ATTACHMENTS_DIR,
  buildPromptWithAttachments,
  materializeAttachments,
  parseShepawAttachments,
  preparePromptFromAttachments,
  safeAttachmentLeaf,
} from '../src/prompt-attachments.js';

let scratch: string | undefined;

afterEach(() => {
  if (scratch) {
    rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  }
});

describe('parseShepawAttachments', () => {
  it('keeps entries with base64 data or on-disk path', () => {
    expect(parseShepawAttachments(undefined)).toEqual([]);
    expect(
      parseShepawAttachments([
        { file_name: 'a.jpg', mime_type: 'image/jpeg', type: 'image', data: 'YQ==' },
        { file_name: 'b.jpg', mime_type: 'image/jpeg', type: 'image', path: '/tmp/b.jpg' },
        { file_name: 'no-data' },
        'bad',
      ]),
    ).toEqual([
      {
        fileId: undefined,
        fileName: 'a.jpg',
        mimeType: 'image/jpeg',
        semanticType: 'image',
        sourcePath: undefined,
        dataBase64: 'YQ==',
        size: undefined,
      },
      {
        fileId: undefined,
        fileName: 'b.jpg',
        mimeType: 'image/jpeg',
        semanticType: 'image',
        sourcePath: '/tmp/b.jpg',
        dataBase64: undefined,
        size: undefined,
      },
    ]);
  });
});

describe('materializeAttachments', () => {
  it('reuses source path without copying into a project cwd', () => {
    scratch = mkdtempSync(join(tmpdir(), 'shepaw-prompt-att-'));
    const peerDir = join(scratch, 'peer-attachments');
    mkdirSync(peerDir, { recursive: true });
    const src = join(peerDir, 'abc_39.jpg');
    writeFileSync(src, 'img-bytes');

    const materialized = materializeAttachments([
      {
        fileId: 'abc123',
        fileName: '39.jpg',
        mimeType: 'image/jpeg',
        semanticType: 'image',
        sourcePath: src,
      },
    ]);
    expect(materialized).toHaveLength(1);
    expect(materialized[0].absPath).toBe(src);

    const blocks = buildPromptWithAttachments('这张图是什么', materialized);
    expect((blocks[0] as { text: string }).text).toContain(src);
    expect((blocks[0] as { text: string }).text).not.toContain('.shepaw/attachments');
    expect(blocks[1]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
  });

  it('writes inline base64 under os.tmpdir, not project cwd', () => {
    const { blocks, materialized } = preparePromptFromAttachments('见附件', [
      {
        file_id: 'f1',
        file_name: 'notes.txt',
        mime_type: 'text/plain',
        type: 'file',
        data: Buffer.from('hello').toString('base64'),
      },
    ]);
    expect(materialized[0].absPath.includes(INLINE_ATTACHMENTS_DIR)).toBe(true);
    expect(materialized[0].absPath.startsWith(tmpdir())).toBe(true);
    expect(blocks.some((b) => b.type === 'resource_link')).toBe(true);
  });

  it('does not create .shepaw under project when path is provided', () => {
    scratch = mkdtempSync(join(tmpdir(), 'shepaw-prompt-att-'));
    const src = join(scratch, 'src.jpg');
    writeFileSync(src, 'img-from-path');
    const projectCwd = join(scratch, 'project');
    mkdirSync(projectCwd, { recursive: true });

    const { materialized } = preparePromptFromAttachments('看图', [
      {
        file_id: 'p1',
        file_name: '39.jpg',
        mime_type: 'image/jpeg',
        type: 'image',
        path: src,
      },
    ]);
    expect(materialized[0].absPath).toBe(src);
    expect(readFileSync(materialized[0].absPath, 'utf8')).toBe('img-from-path');
    expect(existsSync(join(projectCwd, '.shepaw'))).toBe(false);
  });
});

describe('safeAttachmentLeaf', () => {
  it('strips unsafe characters', () => {
    expect(safeAttachmentLeaf('../a b.png')).toBe('.._a_b.png');
  });
});
