import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { assimpCapabilities as described } from './capabilities.js';
import { assimpCapabilities as root } from './index.js';

describe('libassimp/capabilities', () => {
  it('adds a description to every option and step without changing the root data', () => {
    const { description, ...rest } = described.importOptions.globMeasureTime;
    expect(description).toMatch(/time measurements/u);
    expect(rest).toEqual(root.importOptions.globMeasureTime);
    for (const [name, descriptor] of Object.entries(described.importOptions)) {
      expect(descriptor.description, name).not.toBe('');
    }
    for (const [name, step] of Object.entries(described.postProcess)) {
      expect(step.description, name).not.toBe('');
      expect(step.conflicts).toEqual(root.postProcess[name as keyof typeof root.postProcess].conflicts);
    }
    for (const [format, info] of Object.entries(described.export)) {
      const rootInfo = root.export[format as keyof typeof root.export];
      expect(info.id).toBe(rootInfo.id);
      expect(Object.keys(info.exportOptions)).toEqual(Object.keys(rootInfo.exportOptions));
      for (const [name, descriptor] of Object.entries(info.exportOptions)) {
        const { description } = descriptor as { description: string };
        expect(description, `${format}.${name}`).not.toBe('');
        // Forms show these as help text, so each one is prose rather than an Assimp config key.
        expect(description, `${format}.${name}`).not.toMatch(/^\w+\.?$/u);
      }
    }
    expect(described.import).toBe(root.import);
  });

  it('publishes every export option description exactly as authored in the override ledger', () => {
    type Authored = { publicName: string; supported?: boolean; formats?: string[]; description?: string };
    const ledger = JSON.parse(
      readFileSync(new URL('../scripts/assimp-capability-overrides.json', import.meta.url), 'utf8'),
    ) as {
      properties: Record<string, Authored>;
      formats: { routes: Record<string, { options?: Authored[] }> };
    };
    const authored = new Map<string, string | undefined>();
    for (const option of Object.values(ledger.properties)) {
      if (option.supported === false) continue;
      for (const format of option.formats ?? [])
        authored.set(`${format}.${option.publicName}`, option.description);
    }
    for (const [format, route] of Object.entries(ledger.formats.routes)) {
      for (const option of route.options ?? [])
        authored.set(`${format}.${option.publicName}`, option.description);
    }
    for (const [format, info] of Object.entries(described.export)) {
      for (const [name, descriptor] of Object.entries(info.exportOptions)) {
        const key = `${format}.${name}`;
        expect(authored.get(key), key).toBeDefined();
        expect((descriptor as { description: string }).description, key).toBe(authored.get(key));
      }
    }
  });

  it('keeps prose out of the root registry', () => {
    expect(JSON.stringify(root)).not.toContain('"description":"Enables time measurements');
    expect(Object.keys(root.importOptions.globMeasureTime)).not.toContain('description');
  });

  it('states each default once, as data', () => {
    const prose = JSON.stringify(described);
    expect(prose).not.toMatch(/Default value:|Property type:/u);
  });
});
