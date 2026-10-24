import { fileURLToPath } from 'node:url';

export default {
  output: 'export',
  reactStrictMode: true,
  // Server rendering resolves libassimp's Node entry, whose loader requires the
  // native addon package; Next must load it at run time instead of bundling it.
  serverExternalPackages: ['libassimp'],
  // The fixtures share ../src and one node_modules at the fixture root.
  turbopack: { root: fileURLToPath(new URL('..', import.meta.url)) },
};
