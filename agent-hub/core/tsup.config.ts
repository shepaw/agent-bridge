import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/gateway-daemon.ts', 'src/peer/peer-daemon.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  target: 'node18',
});
