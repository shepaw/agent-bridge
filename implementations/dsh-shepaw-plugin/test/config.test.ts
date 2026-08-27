import { afterEach, describe, expect, it } from 'vitest';

import { resolveShepawBridgeConfig } from '../src/config.js';

describe('resolveShepawBridgeConfig', () => {
  const envKeys = ['SHEPAW_DSH_HOST', 'SHEPAW_DSH_PORT'] as const;

  afterEach(() => {
    for (const key of envKeys) delete process.env[key];
  });

  it('prefers SHEPAW_DSH_* env over cordis.patch.yml defaults', () => {
    process.env.SHEPAW_DSH_HOST = '127.0.0.1';
    process.env.SHEPAW_DSH_PORT = '8106';

    const resolved = resolveShepawBridgeConfig({ host: '0.0.0.0', port: 8080 });

    expect(resolved.host).toBe('127.0.0.1');
    expect(resolved.port).toBe(8106);
  });

  it('falls back to yaml then defaults when env is unset', () => {
    const resolved = resolveShepawBridgeConfig({ host: '0.0.0.0', port: 8080 });

    expect(resolved.host).toBe('0.0.0.0');
    expect(resolved.port).toBe(8080);
  });
});
