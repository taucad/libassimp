import { globSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const docsDir = resolve(import.meta.dirname, 'content/docs');

/** Whitespace-separated tokens, fences included: the `wc -w` figure the docs budget has always used. */
const countWords = (source: string): number => source.split(/\s+/u).filter(Boolean).length;

// Ceilings only move down. A raise is a reviewed diff that names the page
// paying for it here; a new page needs a row before it can ship. Measured
// 2026-08-23; each page carries its measured count plus a little slack.
const pageCeilings: Readonly<Record<string, number>> = {
  'api.mdx': 620,
  'guides/choose-an-entry.mdx': 440,
  'guides/convert-a-model.mdx': 440,
  'guides/convert-to-multiple-formats.mdx': 260,
  'guides/apple-quick-look.mdx': 460,
  // Live 3MF controls document four authored properties in the runnable request.
  'guides/export-properties.mdx': 430,
  'guides/handle-failures.mdx': 490,
  'guides/resolve-sidecar-files.mdx': 460,
  'guides/use-in-the-browser.mdx': 470,
  // The end-to-end page now carries the conversion it explains.
  'how-it-works.mdx': 690,
  'index.mdx': 360,
  // Install verification is executable rather than a static transcript.
  'install.mdx': 560,
  'tutorial.mdx': 590,
};
// The site ceiling the documentation plan set: 6,000 MDX words across every page.
const siteCeiling = 6_000;

const pages = globSync('**/*.mdx', { cwd: docsDir })
  .toSorted()
  .map((path) => ({ path, words: countWords(readFileSync(resolve(docsDir, path), 'utf8')) }));

describe('docs word budget', () => {
  it('lists a ceiling for every page and no page that does not exist', () => {
    expect(pages.map(({ path }) => path)).toEqual(Object.keys(pageCeilings).toSorted());
  });

  it.each(pages)('keeps $path within its ceiling', ({ path, words }) => {
    expect(words).toBeLessThanOrEqual(pageCeilings[path] ?? 0);
  });

  it('keeps the site within its ceiling', () => {
    expect(pages.reduce((sum, { words }) => sum + words, 0)).toBeLessThanOrEqual(siteCeiling);
  });
});
