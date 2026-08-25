import { globSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { hasQuickLook } from './lib/assimp-demo';
import {
  demoControls,
  demoExportOptions,
  readDemoOptions,
  substituteDemoValues,
  type DemoControl,
  type DemoValue,
} from './lib/demo-options';
import { llmStringifyMdx } from './lib/llm-stringify-mdx';

const docsDir = resolve(import.meta.dirname, 'content/docs');
const pages = globSync('**/*.mdx', { cwd: docsDir }).map((path) => ({
  path,
  source: readFileSync(resolve(docsDir, path), 'utf8'),
}));
const demos = pages.flatMap(({ path, source }) =>
  [...source.matchAll(/<ConvertDemo>\s*```(\w+)\n([\s\S]*?)```\s*<\/ConvertDemo>/gu)].map((match) => ({
    code: match[2],
    lang: match[1],
    path,
  })),
);

const perturb = (control: DemoControl, current: DemoValue): DemoValue => {
  if (control.kind === 'range')
    return Number(current) === control.max ? control.min : Number(current) + control.step;
  if (control.kind === 'choice')
    return control.choices.find(({ value }) => value !== current)?.value ?? current;
  return `${String(current)} edited`;
};

describe('interactive conversion demos', () => {
  it('serves the canonical cube fixture byte-for-byte', () => {
    expect(readFileSync(resolve(import.meta.dirname, 'public/cube.obj'))).toEqual(
      readFileSync(resolve(import.meta.dirname, '../tests/fixtures/cube.obj')),
    );
  });

  it('puts runnable examples on the main conversion journeys', () => {
    for (const path of [
      'tutorial.mdx',
      'guides/apple-quick-look.mdx',
      'guides/convert-a-model.mdx',
      'guides/resolve-sidecar-files.mdx',
      'guides/use-in-the-browser.mdx',
    ])
      expect(
        demos.some((demo) => demo.path === path),
        path,
      ).toBe(true);
    expect(readFileSync(resolve(import.meta.dirname, 'app/(home)/page.tsx'), 'utf8')).toContain(
      '<ConvertDemo code={homeDemo} />',
    );
  });

  it('serialises every demo back to its exact fenced example', () => {
    for (const { code, lang } of demos) {
      expect(
        llmStringifyMdx({
          attributes: [
            { name: 'code', type: 'mdxJsxAttribute', value: code },
            { name: 'lang', type: 'mdxJsxAttribute', value: lang },
          ],
          name: 'ConvertDemo',
          type: 'mdxJsxFlowElement',
        }),
      ).toBe(`\`\`\`${lang}\n${code}\n\`\`\``);
    }
  });

  it('derives controls from values in the example and can write each value back', () => {
    for (const { code, path } of demos) {
      const seeded = readDemoOptions(code);
      const controls = demoControls(code);
      expect(controls.length, path).toBeGreaterThan(0);
      expect(substituteDemoValues(code, seeded), path).toBe(code);

      for (const control of controls) {
        const current = seeded[control.key];
        expect(current, `${path} ${control.key}`).toBeDefined();
        if (control.kind === 'range') {
          expect(current as number).toBeGreaterThanOrEqual(control.min);
          expect(current as number).toBeLessThanOrEqual(control.max);
        } else if (control.kind === 'choice') {
          expect(
            control.choices.map(({ value }) => value),
            `${path} ${control.key}`,
          ).toContain(current);
        }

        const wanted = perturb(control, current);
        expect(
          readDemoOptions(substituteDemoValues(code, { [control.key]: wanted }))[control.key],
          `${path} ${control.key}`,
        ).toBe(wanted);
      }
    }
  });

  it('projects only options supported by the selected export format', () => {
    const values = {
      to: '3mf',
      unit: 'millimeter',
      decimalPrecision: 8,
      application: 'libassimp docs',
      upAxis: 'y',
      pointClouds: true,
    } as const;
    expect(demoExportOptions(values, '3mf')).toEqual({
      unit: 'millimeter',
      decimalPrecision: 8,
      application: 'libassimp docs',
      upAxis: 'y',
      pointClouds: true,
    });
    expect(demoExportOptions(values, 'glb')).toEqual({ pointClouds: true });
  });

  it('rewrites from the captured literal instead of a replacement substring', () => {
    expect(substituteDemoValues("const options = { to: '3mf' }; // 3mf", { to: 'glb' })).toBe(
      "const options = { to: 'glb' }; // 3mf",
    );
    expect(substituteDemoValues("const options = { unit: 'inch' }; // inch", { unit: 'meter' })).toBe(
      "const options = { unit: 'meter' }; // inch",
    );
  });

  it('exposes the documented 3MF properties and the USDZ target', () => {
    const controls = demoControls(
      demos.find(({ path }) => path === 'guides/export-properties.mdx')?.code ?? '',
    );
    expect(controls.map(({ key }) => key)).toEqual([
      'to',
      'unit',
      'decimalPrecision',
      'application',
      'upAxis',
    ]);
    expect(
      readDemoOptions(demos.find(({ path }) => path === 'guides/apple-quick-look.mdx')?.code ?? '')['to'],
    ).toBe('usdz');
  });

  it('shows Quick Look only on an Apple mobile host that supports AR links', () => {
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const setHost = (platform: string, maxTouchPoints: number, supports: boolean): void => {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { maxTouchPoints, platform, userAgent: 'Mozilla/5.0 Safari/605.1.15' },
      });
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: { createElement: () => ({ relList: { supports: () => supports } }) },
      });
    };

    try {
      setHost('MacIntel', 0, true);
      expect(hasQuickLook()).toBe(false);
      setHost('MacIntel', 5, false);
      expect(hasQuickLook()).toBe(false);
      setHost('MacIntel', 5, true);
      expect(hasQuickLook()).toBe(true);
    } finally {
      if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
      if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor);
      else Reflect.deleteProperty(globalThis, 'document');
    }
  });
});
