import { defineConfig } from 'tsup';

// `@deepseek-ai/*` are peer dependencies resolved from the HOST DSH install —
// they must never be bundled. `shepaw-acp-sdk` is a regular dependency and is
// also kept external so the profile installs it (and its deps) normally.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  target: 'node22',
  external: [/^@deepseek-ai\//, 'shepaw-acp-sdk'],
});
