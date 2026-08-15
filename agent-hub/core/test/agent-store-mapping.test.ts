import { mkdtempSync, mkdirSync, readlinkSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  encodeWorkspaceStorePath,
  ensureAgentStoreMappings,
  isRelativeWorkspaceHref,
  joinStoreUri,
  resolveWorkspaceFileUri,
  workspaceLinkPath,
  workspaceStoreUri,
  agentPrivateStoreUri,
} from '../src/peer/agent-store-mapping.js';
import { PeerLocalStore } from '../src/peer/peer-local-store.js';

describe('agent-store-mapping', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('encodes absolute cwd into store-relative path', () => {
    expect(encodeWorkspaceStorePath('/Users/foo/proj')).toBe('Users/foo/proj');
  });

  it('builds space-first store URIs', () => {
    const device = 'aaaaaaaaaaaaaaaa';
    const agentId = '550e8400-e29b-41d4-a716-446655440000';
    expect(workspaceStoreUri(device, '/tmp/ws')).toBe(
      `store://workspaces/${device}/tmp/ws/`,
    );
    expect(agentPrivateStoreUri(device, agentId)).toBe(
      `store://agents/${device}/${agentId}/`,
    );
  });

  it('creates workspace symlink and agent private dir', () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-map-'));
    const cwd = join(dir, 'project');
    mkdirSync(cwd);
    writeFileSync(join(cwd, 'readme.txt'), 'hi');

    const storeRoot = join(dir, 'store');
    const store = new PeerLocalStore(storeRoot);
    const device = 'bbbbbbbbbbbbbbbb';
    const agentId = '11111111-2222-3333-4444-555555555555';

    const mapping = ensureAgentStoreMappings({
      agentId,
      cwd,
      deviceId: device,
      store,
    });

    expect(mapping.workspaceUri).toBe(workspaceStoreUri(device, cwd));
    expect(mapping.agentUri).toBe(agentPrivateStoreUri(device, agentId));

    const link = workspaceLinkPath(storeRoot, device, cwd);
    expect(existsSync(link)).toBe(true);
    expect(readlinkSync(link)).toBe(cwd);

    const privateDir = join(storeRoot, device, 'agents', agentId);
    expect(existsSync(privateDir)).toBe(true);

    // Store list through the workspace symlink sees cwd files.
    const entries = store.list(device, 'workspaces', encodeWorkspaceStorePath(cwd));
    expect(entries.some((e) => e.path.endsWith('readme.txt'))).toBe(true);
  });

  it('resolves relative markdown hrefs against the mapped workspace', () => {
    const root = 'store://workspaces/aaaaaaaaaaaaaaaa/Users/foo/proj/';
    expect(isRelativeWorkspaceHref('docs/good.md')).toBe(true);
    expect(isRelativeWorkspaceHref('https://example.com/a')).toBe(false);
    expect(isRelativeWorkspaceHref('store://files/aaaaaaaaaaaaaaaa/a.md')).toBe(false);
    expect(joinStoreUri(root, 'docs/good.md')).toBe(
      'store://workspaces/aaaaaaaaaaaaaaaa/Users/foo/proj/docs/good.md',
    );
    expect(joinStoreUri(root, '../secret')).toBeNull();
    expect(resolveWorkspaceFileUri(root, 'docs/good.md')).toBe(
      'store://workspaces/aaaaaaaaaaaaaaaa/Users/foo/proj/docs/good.md',
    );
    expect(resolveWorkspaceFileUri(root, 'https://ex.com/x')).toBeNull();
    expect(resolveWorkspaceFileUri(root, 'store://workspaces/aaaaaaaaaaaaaaaa/other.md')).toBe(
      'store://workspaces/aaaaaaaaaaaaaaaa/other.md',
    );
  });

  it('skips rewriting an already-correct workspace symlink', () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-map-'));
    const cwd = join(dir, 'project');
    mkdirSync(cwd);
    const storeRoot = join(dir, 'store');
    const store = new PeerLocalStore(storeRoot);
    const device = 'cccccccccccccccc';
    const agentId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    ensureAgentStoreMappings({ agentId, cwd, deviceId: device, store });
    const link = workspaceLinkPath(storeRoot, device, cwd);
    const first = readlinkSync(link);
    ensureAgentStoreMappings({ agentId, cwd, deviceId: device, store });
    expect(readlinkSync(link)).toBe(first);
  });
});
