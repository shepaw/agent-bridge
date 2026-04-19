import { describe, expect, it } from 'vitest';

import { jsonrpcNotification, jsonrpcRequest, jsonrpcResponse } from '../src/jsonrpc.js';

describe('jsonrpc builders', () => {
  it('jsonrpcNotification emits method + params (no id)', () => {
    const msg = jsonrpcNotification('ui.textContent', { task_id: 't1', content: 'hi' });
    expect(msg).toEqual({
      jsonrpc: '2.0',
      method: 'ui.textContent',
      params: { task_id: 't1', content: 'hi' },
    });
    expect(msg).not.toHaveProperty('id');
  });

  it('jsonrpcNotification omits params when not provided', () => {
    const msg = jsonrpcNotification('ping');
    expect(msg).toEqual({ jsonrpc: '2.0', method: 'ping' });
    expect(msg).not.toHaveProperty('params');
  });

  it('jsonrpcResponse emits result for success', () => {
    expect(jsonrpcResponse(5, { result: { status: 'ok' } })).toEqual({
      jsonrpc: '2.0',
      id: 5,
      result: { status: 'ok' },
    });
  });

  it('jsonrpcResponse defaults missing result to {} (matches Python)', () => {
    expect(jsonrpcResponse('id-1')).toEqual({
      jsonrpc: '2.0',
      id: 'id-1',
      result: {},
    });
  });

  it('jsonrpcResponse emits error when provided', () => {
    const msg = jsonrpcResponse(null, { error: { code: -32000, message: 'nope' } });
    expect(msg).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'nope' },
    });
    expect(msg).not.toHaveProperty('result');
  });

  it('jsonrpcRequest auto-generates a string id when omitted', () => {
    const msg = jsonrpcRequest('agent.chat', { message: 'hi' });
    expect(msg.jsonrpc).toBe('2.0');
    expect(msg.method).toBe('agent.chat');
    expect(typeof msg.id).toBe('string');
    expect((msg.id as string).length).toBeGreaterThan(8);
    expect(msg.params).toEqual({ message: 'hi' });
  });

  it('jsonrpcRequest honours a supplied id', () => {
    const msg = jsonrpcRequest('agent.chat', undefined, 'fixed-id');
    expect(msg.id).toBe('fixed-id');
    expect(msg).not.toHaveProperty('params');
  });
});
