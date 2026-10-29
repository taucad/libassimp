import { describe, expect, it } from 'vitest';

import { assimpCapabilities as described } from './capabilities.js';
import { assimpCapabilities as root } from './index.js';

type Prose = { readonly description?: string };

const optionProse = (): [string, Prose][] => [
  ...Object.entries(described.importOptions).map(([name, descriptor]): [string, Prose] => [
    `import.${name}`,
    descriptor,
  ]),
  ...Object.entries(described.export).flatMap(([format, info]) =>
    Object.entries(info.exportOptions as Readonly<Record<string, Prose>>).map(
      ([name, descriptor]): [string, Prose] => [`${format}.${name}`, descriptor],
    ),
  ),
];

describe('libassimp/capabilities', () => {
  it('adds handwritten option prose without changing the root data', () => {
    const { description, ...rest } = described.importOptions.globalScaleFactorKey;
    expect(description).toMatch(/^Uniform scale applied to the whole scene/u);
    expect(rest).toEqual(root.importOptions.globalScaleFactorKey);
    for (const [format, info] of Object.entries(described.export)) {
      const rootInfo = root.export[format as keyof typeof root.export];
      expect(info.id).toBe(rootInfo.id);
      expect(Object.keys(info.exportOptions)).toEqual(Object.keys(rootInfo.exportOptions));
      for (const [name, descriptor] of Object.entries(
        info.exportOptions as Readonly<Record<string, Prose>>,
      )) {
        expect(descriptor, `${format}.${name}`).toEqual({
          ...(rootInfo.exportOptions as Readonly<Record<string, object>>)[name],
          ...(descriptor.description === undefined ? {} : { description: descriptor.description }),
        });
      }
    }
    expect(described.import).toBe(root.import);
  });

  it('describes every post-process step', () => {
    for (const [name, step] of Object.entries(described.postProcess)) {
      expect(step.description, name).not.toBe('');
      expect(step.conflicts).toEqual(root.postProcess[name as keyof typeof root.postProcess].conflicts);
    }
  });

  it('omits the description key for self-explanatory options', () => {
    expect(Object.keys(described.export.stl.exportOptions.binary)).not.toContain('description');
    expect(Object.keys(described.export.usdz.exportOptions.animations)).not.toContain('description');
    expect(described.export.stl.exportOptions.binary.kind).toBe('boolean');
  });

  it('writes option prose as plain sentences without engine internals', () => {
    const prose = optionProse().flatMap(([name, { description }]) =>
      description === undefined ? [] : [[name, description] as const],
    );
    expect(prose.length).toBeGreaterThan(100);
    for (const [name, description] of prose) {
      expect(description, name).toMatch(/^[A-Z0-9-].*\.$/su);
      expect(description, name).not.toMatch(/assimp|@link|\\note/iu);
      expect(description, name).not.toMatch(/\bAI_|\baiProcess_|\b[A-Z0-9]+_[A-Z0-9_]+\b/u);
    }
  });

  it('keeps per-format option families on one pattern', () => {
    const families = Object.entries(described.importOptions as Readonly<Record<string, Prose>>).filter(
      ([name]) => /(?:UnitScaleToMeters|UpAxis)$/u.test(name),
    );
    expect(families.length).toBeGreaterThan(30);
    for (const [name, { description }] of families) {
      expect(description, name).toMatch(
        name.endsWith('UpAxis')
          ? /^Axis that points up in .+ files\. Exports rotate the model from it to the target format's up axis\.$/u
          : /^Length of one .+ file unit in meters, for example 0\.001 for millimeters\. Exports convert from it to the target format's unit\.$/u,
      );
    }
  });

  it('keeps prose out of the root registry', () => {
    expect(JSON.stringify(root)).not.toContain('"description":"Uniform scale');
    expect(Object.keys(root.importOptions.globalScaleFactorKey)).not.toContain('description');
  });

  it('states each default once, as data', () => {
    const prose = JSON.stringify(described);
    expect(prose).not.toMatch(/Default value:|Property type:/u);
  });
});
