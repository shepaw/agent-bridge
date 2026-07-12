import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ATTACHMENTS_DIR,
  buildPromptWithAttachments,
  materializeAttachments,
  parseShepawAttachments,
  preparePromptFromAttachments,
  safeAttachmentLeaf,
} from '../src/prompt-attachments.js';

let cwd: string;

afterEach(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
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

describe('materializeAttachments + buildPromptWithAttachments', () => {
  it('writes under cwd/.shepaw/attachments and injects paths + image blocks', () => {
    cwd = mkdtempSync(join(tmpdir(), 'shepaw-prompt-att-'));
    const materialized = materializeAttachments(cwd, [
      {
        fileId: 'abc123',
        fileName: '39.jpg',
        mimeType: 'image/jpeg',
        semanticType: 'image',
        dataBase64: Buffer.from('img-bytes').toString('base64'),
      },
    ]);
    expect(materialized).toHaveLength(1);
    expect(materialized[0].relativePath.startsWith(ATTACHMENTS_DIR)).toBe(true);
    expect(readFileSync(materialized[0].absPath, 'utf8')).toBe('img-bytes');

    const blocks = buildPromptWithAttachments('这张图是什么', materialized);
    expect(blocks[0]).toMatchObject({ type: 'text' });
    expect((blocks[0] as { text: string }).text).toContain('这张图是什么');
    expect((blocks[0] as { text: string }).text).toContain(materialized[0].absPath);
    expect(blocks[1]).toMatchObject({
      type: 'image',
      mimeType: 'image/jpeg',
    });
  });

  it('uses resource_link for non-image files', () => {
    cwd = mkdtempSync(join(tmpdir(), 'shepaw-prompt-att-'));
    const { blocks } = preparePromptFromAttachments(cwd, '见附件', [
      {
        file_id: 'f1',
        file_name: 'notes.txt',
        mime_type: 'text/plain',
        type: 'file',
        data: Buffer.from('hello').toString('base64'),
      },
    ]);
    expect(blocks.some((b) => b.type === 'resource_link')).toBe(true);
    expect((blocks[0] as { text: string }).text).toContain('notes.txt');
  });

  it('copies from source path without requiring inline base64', () => {
    cwd = mkdtempSync(join(tmpdir(), 'shepaw-prompt-att-'));
    const src = join(cwd, 'src.jpg');
    writeFileSync(src, 'img-from-path');
    const { blocks, materialized } = preparePromptFromAttachments(cwd, '看图', [
      {
        file_id: 'p1',
        file_name: '39.jpg',
        mime_type: 'image/jpeg',
        type: 'image',
        path: src,
      },
    ]);
    expect(materialized).toHaveLength(1);
    expect(readFileSync(materialized[0].absPath, 'utf8')).toBe('img-from-path');
    expect(blocks.some((b) => b.type === 'image')).toBe(true);
    expect((blocks[0] as { text: string }).text).toContain(materialized[0].absPath);
  });
});

describe('safeAttachmentLeaf', () => {
  it('strips unsafe characters', () => {
    expect(safeAttachmentLeaf('../a b.png')).toBe('.._a_b.png');
  });
});
