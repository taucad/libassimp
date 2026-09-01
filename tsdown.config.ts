import { defineConfig, type UserConfig } from 'tsdown';

const config: UserConfig = {
  clean: true,
  deps: { neverBundle: [/^\.\/wasm\//u] },
  dts: true,
  entry: ['src/index.ts'],
  format: 'esm',
  // Off deliberately: minification strips the `webpackIgnore` and `vite-ignore`
  // pragmas on the glue import, and a bundler that loses them either follows
  // the edge or warns at every consumer's build. The entries are ~1.5 kB.
  minify: false,
  outDir: 'dist',
  sourcemap: false,
  tsconfig: 'tsconfig.build.json',
  unbundle: true,
};

export default defineConfig(config);
