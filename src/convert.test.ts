import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { AssimpError } from './assimp-error.js';
import { convert, type AssimpFile, type ConvertResult, type ExportFormat } from './index.js';

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`../tests/fixtures/${name}`, import.meta.url)));
const model = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`../assimp/test/models/${name}`, import.meta.url)));

const cube = fixture('cube.obj');
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** The primary output, asserted present so the tests need no non-null hints. */
const primary = (result: ConvertResult): AssimpFile => {
  const [file] = result.files;
  expect(file).toBeDefined();
  return file as AssimpFile;
};

const failure = async (promise: Promise<unknown>): Promise<AssimpError> => {
  const error = await promise.catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(AssimpError);
  expect(error).toBeInstanceOf(Error);
  return error as AssimpError;
};

describe('convert', () => {
  it('converts a single file and names the output from the exporter table', async () => {
    const { files } = await convert({ name: 'cube.obj', bytes: cube }, { to: 'glb' });
    expect(files.map(({ name }) => name)).toEqual(['result.glb']);
    expect(text(files[0]?.bytes.subarray(0, 4) ?? new Uint8Array())).toBe('glTF');
  });

  it('takes the entry file from the first element of an array', async () => {
    const files = [
      { name: 'cube_usemtl.obj', bytes: model('OBJ/cube_usemtl.obj') },
      { name: 'cube_usemtl.mtl', bytes: model('OBJ/cube_usemtl.mtl') },
    ];
    const result = await convert(files, { to: 'glb' });
    expect(result.files[0]?.name).toBe('result.glb');
  });

  it('asks resolve for a referenced file the input does not carry', async () => {
    const asked: string[] = [];
    const { files } = await convert(
      { name: 'cube_usemtl.obj', bytes: model('OBJ/cube_usemtl.obj') },
      {
        to: 'glb',
        resolve: (name) => {
          asked.push(name);
          return name.endsWith('.mtl') ? model('OBJ/cube_usemtl.mtl') : undefined;
        },
      },
    );
    expect(asked).toContain('cube_usemtl.mtl');
    expect(files[0]?.name).toBe('result.glb');
  });

  it('imports without the sidecar when resolve supplies nothing', async () => {
    const { files } = await convert(
      { name: 'cube_usemtl.obj', bytes: model('OBJ/cube_usemtl.obj') },
      { to: 'glb', resolve: () => undefined },
    );
    expect(files[0]?.name).toBe('result.glb');
  });

  it('returns exporter sidecars after the primary output', async () => {
    const { files } = await convert({ name: 'cube.obj', bytes: cube }, { to: 'gltf' });
    expect(files.map(({ name }) => name)).toEqual(['result.gltf', 'result.bin']);
  });

  it.each([
    ['glb', 'result.glb'],
    ['gltf', 'result.gltf'],
    ['glb1', 'result.glb'],
    ['gltf1', 'result.gltf'],
    ['step', 'result.stp'],
    ['stp', 'result.stp'],
    ['dae', 'result.dae'],
    ['collada', 'result.dae'],
    ['assjson', 'result.json'],
    ['stl', 'result.stl'],
  ] as const)('writes %s as %s', async (to, name) => {
    const { files } = await convert({ name: 'cube.obj', bytes: cube }, { to });
    expect(files[0]?.name).toBe(name);
    expect(files[0]?.bytes.byteLength).toBeGreaterThan(0);
  });

  it('separates the glTF generations the aliases name', async () => {
    const two = await convert({ name: 'cube.obj', bytes: cube }, { to: 'gltf' });
    const one = await convert({ name: 'cube.obj', bytes: cube }, { to: 'gltf1' });
    const version = (result: ConvertResult): string =>
      (JSON.parse(text(primary(result).bytes)) as { asset: { version: string } }).asset.version;
    expect(version(two)).toBe('2.0');
    expect(version(one)).toBe('1.0');
  });

  it('passes export properties to the exporter', async () => {
    const compact = await convert({ name: 'cube.obj', bytes: cube }, { to: 'assjson' });
    const pretty = await convert(
      { name: 'cube.obj', bytes: cube },
      { to: 'assjson', properties: { JSON_SKIP_WHITESPACES: false } },
    );
    expect(text(primary(compact).bytes)).not.toContain('\n');
    expect(text(primary(pretty).bytes)).toContain('\n');
    expect(JSON.parse(text(primary(pretty).bytes))).toEqual(JSON.parse(text(primary(compact).bytes)));
  });

  it('ignores property keys the exporter does not know', async () => {
    const plain = await convert({ name: 'cube.obj', bytes: cube }, { to: 'assjson' });
    const noisy = await convert(
      { name: 'cube.obj', bytes: cube },
      { to: 'assjson', properties: { NONEXISTENT_PROPERTY: true, FAKE_COUNT: 42, FAKE_NAME: 'x' } },
    );
    expect(noisy.files[0]?.bytes).toEqual(plain.files[0]?.bytes);
  });

  it('hands back copies the caller owns', async () => {
    const first = await convert({ name: 'cube.obj', bytes: cube }, { to: 'glb' });
    const second = await convert({ name: 'cube.obj', bytes: cube }, { to: 'glb' });
    expect(first.files[0]?.bytes).not.toBe(second.files[0]?.bytes);
    expect(first.files[0]?.bytes).toEqual(second.files[0]?.bytes);
  });

  it('fails with NO_FILES on an empty list', async () => {
    const error = await failure(convert([], { to: 'glb' }));
    expect(error.code).toBe('NO_FILES');
    expect(error.name).toBe('AssimpError');
  });

  it('fails with UNSUPPORTED_FORMAT and lists what this entry exports', async () => {
    const error = await failure(convert({ name: 'cube.obj', bytes: cube }, { to: 'nope' as ExportFormat }));
    expect(error.code).toBe('UNSUPPORTED_FORMAT');
    expect(error.message).toContain('glb2');
    expect(error.message).toContain('Aliases: glb, gltf, glb1, gltf1, step, dae.');
  });

  it('fails with IMPORT_FAILED and assimp diagnostic text', async () => {
    const error = await failure(
      convert({ name: 'broken.obj', bytes: new Uint8Array([1, 2, 3]) }, { to: 'glb' }),
    );
    expect(error.code).toBe('IMPORT_FAILED');
    expect(error.message).toBe('OBJ-file is too small.');
  });

  it('fails with EXPORT_FAILED when the exporter rejects a property value', async () => {
    const error = await failure(
      convert(
        { name: 'cube.obj', bytes: cube },
        // lib3mf accepts a precision of 1 to 16.
        { to: '3mf', properties: { '3MF_EXPORT_DECIMAL_PRECISION': 0 } },
      ),
    );
    expect(error.code).toBe('EXPORT_FAILED');
    expect(error.message).toContain('decimal precision');
  });
});
