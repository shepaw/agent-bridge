import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig } from 'vitest/config';

// Point every ACPAgentServer constructed during tests at a throwaway identity path,
// so real tests never overwrite `~/.config/shepaw-cb-gateway/identity.json`.
// Per-test isolation: identity.test.ts creates its own mkdtemp dirs and passes
// { path } explicitly, bypassing this env var.
const testIdentityDir = mkdtempSync(join(tmpdir(), 'shepaw-sdk-test-identity-'));
process.env.SHEPAW_IDENTITY_PATH = join(testIdentityDir, 'identity.json');

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 10_000,
  },
});
