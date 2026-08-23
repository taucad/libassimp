// The format matrix on the "How it works" page states what each build carries, so it is read out of
// the built package rather than written by hand: every entry is loaded and asked for its own
// `formats()` table. content/docs/format-matrix.json is checked in and format-matrix.test.ts fails
// when regenerating changes it, so a variants.json edit that adds a format shows up as a diff.
import { writeFileSync } from 'node:fs';

const ENTRIES = { full: 'index', importer: 'importer', exporter: 'exporter' };

const matrix = {};
for (const [variant, entry] of Object.entries(ENTRIES)) {
  const { createAssimp } = await import(new URL(`../../dist/${entry}.mjs`, import.meta.url).href);
  using assimp = await createAssimp();
  matrix[variant] = { import: assimp.formats.import, export: assimp.formats.export };
  console.log(`${variant}: ${matrix[variant].import.length} import, ${matrix[variant].export.length} export`);
}

writeFileSync(
  new URL('../content/docs/format-matrix.json', import.meta.url),
  `${JSON.stringify(matrix, undefined, 2)}\n`,
);
console.log('wrote content/docs/format-matrix.json');
