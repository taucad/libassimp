// The tutorial's live demo loads the importer build straight from /demo/, because the glue import
// inside the package is opaque to bundlers by design. The binaries are ten megabytes, so they are
// copied in at build time and git-ignored rather than checked in: a build that has them (CI, or a
// developer who ran `pnpm run build:wasm`) ships a working demo, and a build that does not ships
// the rest of the site with the demo reporting that it could not load.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = new URL('../../src/wasm/', import.meta.url);
const destination = new URL('../public/demo/', import.meta.url);
const names = ['libassimp-importer.js', 'libassimp-importer.wasm'];

const missing = names.filter((name) => !existsSync(new URL(name, source)));
if (missing.length > 0) {
  console.warn(
    `warning: src/wasm/ has no ${missing.join(' or ')}, so the tutorial demo will not run in this ` +
      'build. Run `pnpm run build:wasm -- --all` (needs Docker), or download the CI `wasm-*` ' +
      'artifacts into src/wasm/.',
  );
} else {
  mkdirSync(fileURLToPath(destination), { recursive: true });
  for (const name of names) copyFileSync(new URL(name, source), new URL(name, destination));
  console.log(`copied ${names.length} demo artifacts into public/demo/`);
}
