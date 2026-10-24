import { fileURLToPath } from 'node:url';

export default {
  mode: 'production',
  context: fileURLToPath(new URL('..', import.meta.url)),
  entry: './src/main.js',
  output: { path: fileURLToPath(new URL('dist/', import.meta.url)), publicPath: 'auto', clean: true },
  performance: { hints: false },
};
