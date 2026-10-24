import { fileURLToPath } from 'node:url';

export default {
  output: 'export',
  reactStrictMode: true,
  // The fixtures share ../src and one node_modules at the fixture root.
  turbopack: { root: fileURLToPath(new URL('..', import.meta.url)) },
};
