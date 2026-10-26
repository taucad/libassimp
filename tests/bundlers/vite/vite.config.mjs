import { defineConfig } from 'vite';

// Deliberately the defaults a consumer starts with: no optimizeDeps.exclude.
// Vite 8's dev server pre-bundles libassimp and still resolves its Wasm.
export default defineConfig({
  build: { outDir: 'dist', emptyOutDir: true },
  server: { fs: { allow: ['..'] } },
});
