import { describe, expect, it } from 'vitest';
import { chooseLiveOrMirror } from '../src/peer/peer-store-http.js';

const mirror = { size: 4, sha256: 'old', kind: 'file' };
const live = { size: 5, sha256: 'new', kind: 'file' };

describe('chooseLiveOrMirror', () => {
  it('uses the live answer when the peer replies', () => {
    expect(chooseLiveOrMirror(mirror, live)).toBe(live);
    expect(chooseLiveOrMirror(mirror, { _error: 'not_found', message: 'gone' })).toMatchObject({
      _error: 'not_found',
    });
    expect(chooseLiveOrMirror(mirror, { _error: 'acl_denied' })).toMatchObject({
      _error: 'acl_denied',
    });
  });

  it('keeps the mirror only when the peer cannot be reached', () => {
    expect(chooseLiveOrMirror(mirror, { _error: 'master_offline' })).toBe(mirror);
    expect(chooseLiveOrMirror(mirror, { _error: 'not_paired' })).toBe(mirror);
    expect(chooseLiveOrMirror(mirror, { _error: 'peer_offline' })).toBe(mirror);
    expect(chooseLiveOrMirror({ _error: 'not_found' }, { _error: 'master_offline', message: 'timeout' }))
      .toMatchObject({ _error: 'master_offline' });
  });

  it('does not treat an empty list as a mirror', () => {
    const empty = { entries: [] as unknown[] };
    const filled = { entries: [{ path: 'a.txt' }] };
    const offline = { _error: 'peer_offline', message: 'down' };
    expect(chooseLiveOrMirror(empty, offline, { emptyMirrorIsMiss: true })).toBe(offline);
    expect(chooseLiveOrMirror(filled, offline, { emptyMirrorIsMiss: true })).toBe(filled);
    expect(chooseLiveOrMirror(filled, { entries: [] }, { emptyMirrorIsMiss: true })).toEqual({
      entries: [],
    });
  });
});
