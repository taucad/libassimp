// Every TypeScript fence a reader can copy is compiled against the published
// declarations, under the settings a consumer's own project uses. It reads
// `dist/`, so run `pnpm run build` first; the Nx `test` target does.
import { execFileSync } from 'node:child_process';
import { existsSync, globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const documents = ['README.md', ...globSync('docs-site/content/docs/**/*.mdx', { cwd: root })].sort(
  (left, right) => (left < right ? -1 : 1),
);

/** Fenced TypeScript blocks, in document order. */
const fences = (markdown) =>
  [...markdown.matchAll(/^```(?:typescript|ts)\n([\s\S]*?)^```/gmu)].map((match) => match[1]);

const work = mkdtempSync(join(tmpdir(), 'libassimp-fences-'));
afterAll(() => rmSync(work, { force: true, recursive: true }));

const blocks = documents.flatMap((document) =>
  fences(readFileSync(join(root, document), 'utf8')).map((code, index) => [`${document}#${index}`, code]),
);

describe('documentation fences', () => {
  it('finds a fence to check', () => {
    expect(fences('```typescript\nconst checked = true;\n```')).toEqual(['const checked = true;\n']);
    expect(blocks.length).toBeGreaterThan(0);
  });

  it('compiles every TypeScript fence against the published declarations', () => {
    expect(existsSync(join(root, 'dist/index.d.mts')), 'run `pnpm run build` first').toBe(true);
    for (const [id, code] of blocks) {
      writeFileSync(join(work, `${id.replaceAll(/[^\w]/gu, '_')}.ts`), code);
    }
    writeFileSync(
      join(work, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          // A consumer's defaults, not this repository's stricter set.
          lib: ['ES2024', 'DOM'],
          module: 'ESNext',
          moduleResolution: 'Bundler',
          noEmit: true,
          skipLibCheck: true,
          strict: true,
          target: 'ES2024',
          types: ['node'],
          typeRoots: [join(root, 'node_modules/@types')],
          paths: {
            libassimp: [join(root, 'dist/index.d.mts')],
            'libassimp/importer': [join(root, 'dist/importer.d.mts')],
            'libassimp/exporter': [join(root, 'dist/exporter.d.mts')],
          },
        },
        include: ['*.ts'],
      }),
    );
    const tsc = join(root, 'node_modules/typescript/bin/tsc');
    expect(() =>
      execFileSync(process.execPath, [tsc, '--project', join(work, 'tsconfig.json')], {
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });
});
