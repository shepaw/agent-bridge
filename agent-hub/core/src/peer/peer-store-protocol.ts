/**
 * store.* frame dispatch for the hub peer channel.
 *
 * Inbound: paired phones can list/meta/read shared spaces on this hub's store,
 * and write into their own device directory (mirror backup when hub is master).
 * Outbound: hub can request store ops on a live paired peer (remote read).
 */

import { randomUUID } from 'node:crypto';
import {
  ALL_SPACES,
  SHARED_SPACES,
  getPeerLocalStore,
  type PeerLocalStore,
} from './peer-local-store.js';
import { loadPairedPeers } from './peer-store.js';
import { sendToPeer } from './peer-connection.js';

const CALL_TIMEOUT_MS = 15_000;

export type StoreFrame = {
  type: 'store';
  ns: 'store';
  op: string;
  v: number;
  req_id?: string;
  [key: string]: unknown;
};

type Pending = {
  resolve: (data: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

/** peerId → req_id → pending */
const pendingByPeer = new Map<string, Map<string, Pending>>();

function errorCode(e: unknown): string {
  if (e && typeof e === 'object' && 'code' in e && typeof (e as { code: unknown }).code === 'string') {
    return (e as { code: string }).code;
  }
  return 'internal';
}

function resultFrame(reqId: string | undefined, data: Record<string, unknown>): StoreFrame {
  return {
    type: 'store',
    ns: 'store',
    op: 'result',
    v: 1,
    req_id: reqId,
    data,
  };
}

function errorFrame(
  reqId: string | undefined,
  code: string,
  message?: string,
): StoreFrame {
  return {
    type: 'store',
    ns: 'store',
    op: 'error',
    v: 1,
    req_id: reqId,
    code,
    message: message ?? code,
  };
}

function parseUri(uri: string): { space: string; device: string; path: string } | null {
  // Allow space root: store://<space>/<device> or store://<space>/<device>/
  const m = /^store:\/\/([^/]+)\/([a-f0-9]{16})(?:\/(.*))?$/i.exec(uri.trim());
  if (!m) return null;
  const path = (m[3] ?? '').replace(/\/+$/, '');
  return { space: m[1]!, device: m[2]!.toLowerCase(), path };
}

/**
 * Handle an inbound store frame from a paired peer.
 * Returns a response frame (result/error) or null for fire-and-forget.
 */
export function handleInboundStoreFrame(
  frame: Record<string, unknown>,
  opts: {
    peerId: string;
    callerDeviceId: string;
    store?: PeerLocalStore;
  },
): StoreFrame | null {
  const op = String(frame.op ?? '');
  const reqId = typeof frame.req_id === 'string' ? frame.req_id : undefined;
  const store = opts.store ?? getPeerLocalStore();

  // Response to our outbound call
  if (op === 'result' || op === 'error') {
    const bucket = pendingByPeer.get(opts.peerId);
    if (reqId && bucket?.has(reqId)) {
      const pending = bucket.get(reqId)!;
      bucket.delete(reqId);
      clearTimeout(pending.timer);
      if (op === 'error') {
        pending.resolve({
          _error: String(frame.code ?? 'internal'),
          message: String(frame.message ?? ''),
        });
      } else {
        const data =
          frame.data && typeof frame.data === 'object'
            ? (frame.data as Record<string, unknown>)
            : {};
        pending.resolve(data);
      }
    }
    return null;
  }

  try {
    const data = dispatchLocal(store, op, frame, opts.callerDeviceId);
    return resultFrame(reqId, data);
  } catch (e) {
    return errorFrame(reqId, errorCode(e), e instanceof Error ? e.message : String(e));
  }
}

function dispatchLocal(
  store: PeerLocalStore,
  op: string,
  frame: Record<string, unknown>,
  callerDeviceId: string,
): Record<string, unknown> {
  const space = typeof frame.space === 'string' ? frame.space : undefined;
  const device =
    typeof frame.device === 'string' ? frame.device : callerDeviceId;
  const path = typeof frame.path === 'string' ? frame.path : undefined;

  switch (op) {
    case 'list': {
      if (!space) throw Object.assign(new Error('space required'), { code: 'bad_op' });
      assertReadable(space, device, callerDeviceId);
      const prefix = typeof frame.path === 'string' ? frame.path : undefined;
      const limit = typeof frame.limit === 'number' ? frame.limit : 1000;
      const depth =
        typeof frame.depth === 'number'
          ? frame.depth
          : typeof frame.depth === 'string' && frame.depth.trim()
            ? Number(frame.depth)
            : undefined;
      const entries = store.list(
        device,
        space,
        prefix,
        limit,
        Number.isFinite(depth) ? depth : undefined,
      );
      return { entries, next_cursor: null };
    }
    case 'meta': {
      if (!space || !path) throw Object.assign(new Error('space/path required'), { code: 'bad_op' });
      assertReadable(space, device, callerDeviceId);
      return store.meta(device, space, path);
    }
    case 'read': {
      if (!space || !path) throw Object.assign(new Error('space/path required'), { code: 'bad_op' });
      assertReadable(space, device, callerDeviceId);
      const offset = typeof frame.offset === 'number' ? frame.offset : 0;
      const length = typeof frame.length === 'number' ? frame.length : 64 * 1024;
      const { data, size, eof } = store.read(device, space, path, offset, length);
      return { data: data.toString('base64'), size, eof };
    }
    case 'write.begin': {
      if (!space || !path) throw Object.assign(new Error('space/path required'), { code: 'bad_op' });
      return store.writeBegin({
        deviceId: callerDeviceId,
        space,
        path,
        size: typeof frame.size === 'number' ? frame.size : -1,
        sha256: typeof frame.sha256 === 'string' ? frame.sha256 : '',
        uploadId: typeof frame.upload_id === 'string' ? frame.upload_id : undefined,
      });
    }
    case 'write.chunk': {
      if (!space) throw Object.assign(new Error('space required'), { code: 'bad_op' });
      const uploadId = String(frame.upload_id ?? '');
      const offset = typeof frame.offset === 'number' ? frame.offset : 0;
      const b64 = String(frame.data ?? '');
      return store.writeChunk(callerDeviceId, uploadId, offset, Buffer.from(b64, 'base64'));
    }
    case 'commit': {
      if (!space) throw Object.assign(new Error('space required'), { code: 'bad_op' });
      const uploadIds = Array.isArray(frame.upload_ids)
        ? frame.upload_ids.map(String)
        : [];
      const upto =
        typeof frame.upto_seq === 'number' ? frame.upto_seq : undefined;
      return store.commit(callerDeviceId, space, uploadIds, upto);
    }
    case 'delete': {
      if (!space || !path) throw Object.assign(new Error('space/path required'), { code: 'bad_op' });
      const upto =
        typeof frame.upto_seq === 'number' ? frame.upto_seq : undefined;
      return store.delete(callerDeviceId, space, path, upto);
    }
    case 'sync.hello': {
      const target =
        typeof frame.device === 'string' ? frame.device : callerDeviceId;
      return { applied_seq: store.appliedSeq(target) };
    }
    default:
      throw Object.assign(new Error(`bad_op: ${op}`), { code: 'bad_op' });
  }
}

function assertReadable(space: string, device: string, caller: string): void {
  if (!ALL_SPACES.has(space)) {
    throw Object.assign(new Error('bad_op'), { code: 'bad_op' });
  }
  if (device === caller) return;
  if (SHARED_SPACES.has(space)) return;
  throw Object.assign(new Error('acl_denied'), { code: 'acl_denied' });
}

/**
 * Send a store request to a live paired peer (by peer UUID id) and wait for result.
 */
export function callStoreOnPeerId(
  peerId: string,
  op: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const reqId = randomUUID();
  const frame: StoreFrame = {
    type: 'store',
    ns: 'store',
    op,
    v: 1,
    req_id: reqId,
    ...payload,
  };
  return new Promise((resolve, reject) => {
    let bucket = pendingByPeer.get(peerId);
    if (!bucket) {
      bucket = new Map();
      pendingByPeer.set(peerId, bucket);
    }
    const timer = setTimeout(() => {
      bucket!.delete(reqId);
      resolve({ _error: 'master_offline', message: 'timeout' });
    }, CALL_TIMEOUT_MS);
    bucket.set(reqId, { resolve, reject, timer });
    const ok = sendToPeer(peerId, frame);
    if (!ok) {
      clearTimeout(timer);
      bucket.delete(reqId);
      resolve({ _error: 'master_offline', message: 'peer not connected' });
    }
  });
}

/** Resolve fingerprint → peer id and call. */
export function callStoreOnDevice(
  deviceFingerprint: string,
  op: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const peer = loadPairedPeers().find((p) => p.fingerprint === deviceFingerprint);
  if (!peer) {
    return Promise.resolve({ _error: 'not_paired', message: 'device not paired' });
  }
  return callStoreOnPeerId(peer.id, op, payload);
}

/** Local-first store op used by HTTP / agent tools. */
export function executeLocalStoreOp(
  op: string,
  payload: Record<string, unknown>,
  selfDeviceId: string,
): Record<string, unknown> {
  try {
    return dispatchLocal(getPeerLocalStore(), op, payload, selfDeviceId);
  } catch (e) {
    return {
      _error: errorCode(e),
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

export function parseStoreUri(uri: string): {
  space: string;
  device: string;
  path: string;
} | null {
  return parseUri(uri);
}
