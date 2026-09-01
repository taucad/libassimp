// Static metadata is the format source of truth; generating docs must never load Wasm.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { assimpCapabilities } = await import(new URL('../../dist/index.mjs', import.meta.url).href);
const matrix = {
  import: Object.values(assimpCapabilities.import),
  export: Object.values(assimpCapabilities.export),
};
console.log(`${matrix.import.length} import, ${matrix.export.length} export`);

const target = new URL('../content/docs/format-matrix.json', import.meta.url);
const formatted = execFileSync('pnpm', ['exec', 'oxfmt', `--stdin-filepath=${fileURLToPath(target)}`], {
  cwd: new URL('../../', import.meta.url),
  encoding: 'utf8',
  input: `${JSON.stringify(matrix, undefined, 2)}\n`,
});
writeFileSync(target, formatted);
console.log('wrote content/docs/format-matrix.json');
