import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createAssimp } from './index.js';
import { convert as convertGltf, createAssimp as createImporter } from './importer.js';
import { convert as convertFromGltf } from './exporter.js';

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`../tests/fixtures/${name}`, import.meta.url)));
const cube = fixture('cube.obj');
const wasmPath = new URL('./wasm/libassimp-full.wasm', import.meta.url);

describe('createAssimp', () => {
  it('converts on an instance and reports the compiled formats', async () => {
    const assimp = await createAssimp();
    try {
      const { files } = await assimp.convert({ name: 'cube.obj', bytes: cube }, { to: 'glb' });
      expect(files[0]?.name).toBe('result.glb');
      expect(assimp.formats.export.map(({ id }) => id)).toContain('glb2');
      expect(assimp.formats.import.map(({ id }) => id)).toContain('obj');
    } finally {
      assimp.dispose();
    }
  });

  it.each([
    ['a URL', wasmPath],
    ['a string', wasmPath.href],
  ])('loads the binary from wasmUrl given as %s', async (_label, wasmUrl) => {
    const assimp = await createAssimp({ wasmUrl });
    try {
      const { files } = await assimp.convert({ name: 'cube.obj', bytes: cube }, { to: 'glb' });
      expect(files[0]?.bytes.byteLength).toBeGreaterThan(0);
    } finally {
      assimp.dispose();
    }
  });

  it('instantiates an already-fetched wasmBinary', async () => {
    const assimp = await createAssimp({ wasmBinary: new Uint8Array(readFileSync(wasmPath)) });
    try {
      const { files } = await assimp.convert({ name: 'cube.obj', bytes: cube }, { to: 'glb' });
      expect(files[0]?.name).toBe('result.glb');
    } finally {
      assimp.dispose();
    }
  });

  it('sends the module diagnostics of an unreachable binary to onLog', async () => {
    const entries: { level: string; message: string }[] = [];
    const missing = new URL('./wasm/libassimp-absent.wasm', import.meta.url);
    await expect(createAssimp({ wasmUrl: missing, onLog: (entry) => entries.push(entry) })).rejects.toThrow();
    expect(entries.map(({ level }) => level)).toContain('error');
    expect(entries.map(({ message }) => message).join('\n')).toContain('libassimp-absent.wasm');
  });

  it('drops the same diagnostics when no onLog is given', async () => {
    const missing = new URL('./wasm/libassimp-absent.wasm', import.meta.url);
    await expect(createAssimp({ wasmUrl: missing })).rejects.toThrow();
  });

  it('rejects conversions once disposed', async () => {
    const assimp = await createAssimp();
    assimp.dispose();
    assimp.dispose();
    await expect(assimp.convert({ name: 'cube.obj', bytes: cube }, { to: 'glb' })).rejects.toThrow(
      'assimp instance disposed',
    );
  });

  it('disposes at the end of a using scope', async () => {
    let escaped: Awaited<ReturnType<typeof createAssimp>> | undefined;
    {
      using assimp = await createAssimp();
      escaped = assimp;
      const { files } = await assimp.convert({ name: 'cube.obj', bytes: cube }, { to: 'glb' });
      expect(files).toHaveLength(1);
    }
    await expect(escaped.convert({ name: 'cube.obj', bytes: cube }, { to: 'glb' })).rejects.toThrow(
      'assimp instance disposed',
    );
  });

  it('registers no process listeners', async () => {
    // Emscripten 6 wires no Node handlers, so a host that creates many
    // instances keeps the same listener counts it started with.
    const before = ['unhandledRejection', 'uncaughtException'].map((event) => process.listenerCount(event));
    const instances = await Promise.all(Array.from({ length: 5 }, () => createAssimp()));
    for (const assimp of instances) assimp.dispose();
    expect(['unhandledRejection', 'uncaughtException'].map((event) => process.listenerCount(event))).toEqual(
      before,
    );
  });
});

describe('entries', () => {
  it('imports any format and writes glTF through libassimp/importer', async () => {
    const { files } = await convertGltf({ name: 'cube.obj', bytes: cube }, { to: 'glb' });
    expect(files[0]?.name).toBe('result.glb');

    const assimp = await createImporter();
    try {
      expect(assimp.formats.import.map(({ id }) => id)).toContain('fbx');
    } finally {
      assimp.dispose();
    }
  });

  it.each(['stl', '3mf', 'usda'] as const)('writes %s from glTF through libassimp/exporter', async (to) => {
    const { files } = await convertGltf({ name: 'cube.obj', bytes: cube }, { to: 'glb' });
    const exported = await convertFromGltf(
      { name: 'model.glb', bytes: files[0]?.bytes ?? new Uint8Array() },
      { to },
    );
    expect(exported.files[0]?.name).toBe(`result.${to}`);
    expect(exported.files[0]?.bytes.byteLength).toBeGreaterThan(0);
  });
});
