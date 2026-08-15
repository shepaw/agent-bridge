import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    target: 'node18',
  },
  {
    entry: [
      'src/cli.ts',
      'src/peer-store-mcp.ts',
      'src/shepaw-cli.ts',
      'src/zcode-app-server-proxy.ts',
    ],
    format: ['esm'],
    dts: false,
    sourcemap: true,
    clean: false,
    splitting: false,
    target: 'node18',
    banner: { js: '#!/usr/bin/env node' },
  },
]);
