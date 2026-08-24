import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { AssimpError } from './assimp-error.js';
import { validatePlanOptions } from './assimp-options.js';
import {
  prepareConversion,
  ResolutionContext,
  runPreparedConversion,
  type NativeRuntime,
  type PreparedConversion,
} from './convert.js';
import {
  convert,
  convertFormats,
  createAssimp,
  defaultPostProcess,
  type AssimpFile,
  type ConvertResult,
} from './index.js';

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`../tests/fixtures/${name}`, import.meta.url)));
const model = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`../assimp/test/models/${name}`, import.meta.url)));
const cube = fixture('cube.obj');
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const primary = (result: ConvertResult): AssimpFile => {
  const [file] = result.files;
  expect(file).toBeDefined();
  return file as AssimpFile;
};

const failure = async (promise: Promise<unknown>): Promise<AssimpError> => {
  const error = await promise.catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(AssimpError);
  return error as AssimpError;
};

describe('convert and convertFormats', () => {
  it('maps ordered repeated targets positionally', async () => {
    const results = await convertFormats(
      { name: 'cube.obj', bytes: cube },
      {
        targets: [
          { to: 'glb' },
          { to: 'stl', exportOptions: { binary: false } },
          { to: 'stl', exportOptions: { binary: true } },
        ],
      },
    );
    expect(results.map(({ format }) => format)).toEqual(['glb', 'stl', 'stl']);
    expect(results.map(({ files }) => files[0]?.name)).toEqual(['result.glb', 'result.stl', 'result.stl']);
    expect(results[1].files[0]?.bytes).not.toEqual(results[2].files[0]?.bytes);
  });

  it('keeps singular output byte-identical to a one-target plan', async () => {
    const singular = await convert({ name: 'cube.obj', bytes: cube }, { to: 'gltf' });
    const [plural] = await convertFormats({ name: 'cube.obj', bytes: cube }, { targets: [{ to: 'gltf' }] });
    expect(plural.files).toEqual(singular.files);
    expect(plural.files.map(({ name }) => name)).toEqual(['result.gltf', 'result.bin']);
  });

  it('passes all provided source and sidecar files', async () => {
    const files = [
      { name: 'cube_usemtl.obj', bytes: model('OBJ/cube_usemtl.obj') },
      { name: 'cube_usemtl.mtl', bytes: model('OBJ/cube_usemtl.mtl') },
    ];
    const result = await convert(files, { to: 'glb' });
    expect(primary(result).name).toBe('result.glb');
  });

  it('resolves a sidecar asynchronously without prefetch and calls once per exact name', async () => {
    const asked: string[] = [];
    const result = await convert(
      { name: 'cube_usemtl.obj', bytes: model('OBJ/cube_usemtl.obj') },
      {
        to: 'glb',
        resolve: async (name) => {
          asked.push(name);
          await Promise.resolve();
          return name.endsWith('.mtl') ? model('OBJ/cube_usemtl.mtl') : undefined;
        },
      },
    );
    expect(primary(result).name).toBe('result.glb');
    expect(asked.filter((name) => name === 'cube_usemtl.mtl')).toHaveLength(1);
  });

  it('treats direct and promised missing files identically', async () => {
    const input = { name: 'cube_usemtl.obj', bytes: model('OBJ/cube_usemtl.obj') };
    const direct = await convert(input, { to: 'glb', resolve: () => undefined });
    const promised = await convert(input, { to: 'glb', resolve: async () => undefined });
    expect(promised.files).toEqual(direct.files);
  });

  it('maps resolver throw and rejection to typed failure context', async () => {
    const input = { name: 'cube_usemtl.obj', bytes: model('OBJ/cube_usemtl.obj') };
    const cause = new Error('storage offline');
    for (const resolve of [
      () => {
        throw cause;
      },
      async () => Promise.reject(cause),
    ]) {
      const error = await failure(convert(input, { to: 'glb', resolve }));
      expect(error.code).toBe('RESOLVE_FAILED');
      expect(error.fileName).toBe('cube_usemtl.mtl');
      expect(error.cause).toBe(cause);
    }
  });

  it('applies generated export options and semantic defaults', async () => {
    const compact = await convert({ name: 'cube.obj', bytes: cube }, { to: 'assjson' });
    const pretty = await convert(
      { name: 'cube.obj', bytes: cube },
      { to: 'assjson', exportOptions: { skipWhitespaces: false } },
    );
    expect(text(primary(compact).bytes)).not.toContain('\n');
    expect(text(primary(pretty).bytes)).toContain('\n');
    expect(JSON.parse(text(primary(pretty).bytes))).toEqual(JSON.parse(text(primary(compact).bytes)));
  });

  it('routes OBJ materials and binary/ASCII variants through public options', async () => {
    const input = [
      { name: 'cube_usemtl.obj', bytes: model('OBJ/cube_usemtl.obj') },
      { name: 'cube_usemtl.mtl', bytes: model('OBJ/cube_usemtl.mtl') },
    ];
    const [withMaterials, withoutMaterials, asciiPly, binaryPly] = await convertFormats(input, {
      targets: [
        { to: 'obj' },
        { to: 'obj', exportOptions: { materials: false } },
        { to: 'ply' },
        { to: 'ply', exportOptions: { binary: true } },
      ],
    });
    expect(withMaterials.files.map(({ name }) => name)).toContain('result.mtl');
    expect(withoutMaterials.files.map(({ name }) => name)).toEqual(['result.obj']);
    expect(text(asciiPly.files[0]?.bytes ?? new Uint8Array())).toContain('format ascii');
    expect(text(binaryPly.files[0]?.bytes.subarray(0, 80) ?? new Uint8Array())).toContain(
      'format binary_little_endian',
    );
  });

  it('uses generated named post-process steps and an exact replacement array', async () => {
    expect(defaultPostProcess).toEqual([
      'triangulate',
      'generateUvCoordinates',
      'joinIdenticalVertices',
      'sortByPrimitiveType',
    ]);
    const result = await convert(
      { name: 'cube.obj', bytes: cube },
      { to: 'glb', postProcess: [...defaultPostProcess, 'optimizeMeshes'] },
    );
    expect(primary(result).name).toBe('result.glb');
  });
});

describe('validation and atomic errors', () => {
  it.each([
    [{ targets: [] }, 'targets: expected a non-empty array'],
    [{ targets: [{ to: '3mf', exportOptions: { decimalPrecision: 0 } }] }, 'expected at least 1'],
    [{ targets: [{ to: 'glb', exportOptions: { binary: true } }] }, 'unknown or inapplicable'],
    [{ targets: [{ to: 'glb' }], importOptions: { favourSpeed: 'yes' } }, 'expected boolean'],
    [{ targets: [{ to: 'glb' }], postProcess: ['generateNormals', 'generateSmoothNormals'] }, 'conflicts'],
  ] as const)('rejects invalid runtime options before conversion', async (options, message) => {
    const error = await failure(convertFormats({ name: 'cube.obj', bytes: cube }, options as never));
    expect(error.code).toBe('INVALID_OPTIONS');
    expect(error.message).toContain(message);
  });

  it('preserves unsupported-format positional context without importing', async () => {
    const error = await failure(
      convertFormats(
        { name: 'cube.obj', bytes: cube },
        { targets: [{ to: 'glb' }, { to: 'nope' as 'glb' }] },
      ),
    );
    expect(error.code).toBe('UNSUPPORTED_FORMAT');
    expect(error.formatIndex).toBe(1);
    expect(error.format).toBe('nope');
  });

  it('rejects glTF 1 while retaining glTF 2', async () => {
    const versionOne = model('glTF/BoxTextured-glTF-Binary/BoxTextured.glb');
    const error = await failure(convert({ name: 'legacy.glb', bytes: versionOne }, { to: 'glb' }));
    expect(error.code).toBe('IMPORT_FAILED');
    const versionTwo = model('glTF2/BoxTextured-glTF-Binary/BoxTextured.glb');
    expect(primary(await convert({ name: 'modern.glb', bytes: versionTwo }, { to: 'glb' })).name).toBe(
      'result.glb',
    );
  });

  it.each([
    [{ importGlobalKeyframe: 1.5 }, 'expected integer'],
    [{ globalScaleFactorKey: Number.POSITIVE_INFINITY }, 'expected finite number'],
    [{ importOgreMaterialFile: 1 }, 'expected string'],
    [{ ppPtvRootTransformation: 'matrix' }, 'expected 16 finite numbers'],
    [{ ppPtvRootTransformation: Array.from({ length: 15 }, () => 0) }, 'expected 16 finite numbers'],
    [
      { ppPtvRootTransformation: [...Array.from({ length: 15 }, () => 0), Number.NaN] },
      'expected 16 finite numbers',
    ],
    [{ '3dsUpAxis': 'q' }, 'expected one of x, y, z'],
  ] as const)('validates every generated import storage shape', (importOptions, message) => {
    expect(() => validatePlanOptions({ targets: [{ to: 'glb' }], importOptions }, new Set(['glb']))).toThrow(
      message,
    );
  });

  it('collects structural, enum, maximum, unknown-step, and duplicate-step errors', () => {
    expect(() =>
      validatePlanOptions(
        {
          targets: [
            null,
            { to: '3mf', exportOptions: 'bad' },
            { to: '3mf', exportOptions: { unit: 'yard' } },
          ],
          importOptions: 'bad',
          postProcess: ['not-a-step', 'triangulate', 'triangulate'],
        },
        new Set(['3mf']),
      ),
    ).toThrow(/expected object[\s\S]*unknown step[\s\S]*duplicate step[\s\S]*expected one of/u);
    expect(() =>
      validatePlanOptions(
        { targets: [{ to: '3mf', exportOptions: { decimalPrecision: 18 } }] },
        new Set(['3mf']),
      ),
    ).toThrow('expected at most 16');
  });

  it('maps public defaults, enums, and boolean properties to native values', () => {
    const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;
    const plan = validatePlanOptions(
      {
        targets: [{ to: '3mf', exportOptions: { unit: 'meter', upAxis: 'x' } }],
        importOptions: { favourSpeed: true, '3dsUpAxis': 'x', ppPtvRootTransformation: matrix },
      },
      new Set(['3mf']),
    );
    expect(plan.importProperties).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'FAVOUR_SPEED', kind: 'integer', value: 1 }),
        expect.objectContaining({ name: 'IMPORT_3DS_UP_AXIS', kind: 'integer', value: 0 }),
        expect.objectContaining({ name: 'PP_PTV_ROOT_TRANSFORMATION', kind: 'matrix', value: matrix }),
      ]),
    );
    expect(plan.targets[0]).toMatchObject({ format: '3mf', nativeId: '3mf' });
  });

  it('rejects a non-array post-process value', () => {
    expect(() =>
      validatePlanOptions({ targets: [{ to: 'glb' }], postProcess: 'triangulate' }, new Set(['glb'])),
    ).toThrow('postProcess: expected array');
  });

  it('rejects invalid file collections before native work', () => {
    const options = { targets: [{ to: 'glb' }] } as const;
    expect(() => prepareConversion([], options, new Set(['glb']))).toThrow('at least one input file');
    expect(() => prepareConversion([{} as AssimpFile], options, new Set(['glb']))).toThrow(
      'expected { name, bytes }',
    );
  });
});

describe('resolver and staged-plan internals', () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const dispatchName = (
    context: ResolutionContext,
    name: string,
    suspending: boolean,
  ): number | Promise<number> => {
    const encoded = new TextEncoder().encode(name);
    new Uint8Array(memory.buffer, 0, encoded.length).set(encoded);
    return context.dispatch({ operation: 1, first: 0, second: encoded.length, memory, suspending });
  };

  it('handles direct missing, invalid, zero-length, copy, release, and unknown dispatches', () => {
    const missing = new ResolutionContext(undefined);
    expect(dispatchName(missing, 'missing.bin', false)).toBe(0);
    expect(dispatchName(missing, 'missing.bin', false)).toBe(0);

    const invalid = new ResolutionContext(() => [] as unknown as Uint8Array);
    expect(dispatchName(invalid, 'invalid.bin', false)).toBe(-1);
    expect(invalid.getFailure()).toMatchObject({ fileName: 'invalid.bin' });

    const empty = new ResolutionContext(() => new Uint8Array());
    const emptyHandle = dispatchName(empty, 'empty.bin', false) as number;
    expect(emptyHandle).toBeGreaterThan(0);
    expect(empty.dispatch({ operation: 2, first: emptyHandle, second: 0, memory, suspending: false })).toBe(
      0,
    );
    expect(empty.dispatch({ operation: 3, first: emptyHandle, second: 64, memory, suspending: false })).toBe(
      0,
    );

    const ready = new ResolutionContext(() => new Uint8Array([4, 5, 6]));
    const handle = dispatchName(ready, 'ready.bin', false) as number;
    expect(ready.dispatch({ operation: 2, first: handle, second: 0, memory, suspending: false })).toBe(3);
    expect(ready.dispatch({ operation: 3, first: handle, second: 32, memory, suspending: false })).toBe(3);
    expect(new Uint8Array(memory.buffer, 32, 3)).toEqual(new Uint8Array([4, 5, 6]));
    expect(ready.dispatch({ operation: 4, first: handle, second: 0, memory, suspending: false })).toBe(0);
    expect(ready.dispatch({ operation: 2, first: handle, second: 0, memory, suspending: false })).toBe(-1);
    expect(ready.dispatch({ operation: 3, first: handle, second: 0, memory, suspending: false })).toBe(-1);
    expect(ready.dispatch({ operation: 99, first: 0, second: 0, memory, suspending: false })).toBe(-1);
  });

  it('shares one pending resolver between replay and suspension', async () => {
    let release: ((bytes: Uint8Array | undefined) => void) | undefined;
    const context = new ResolutionContext(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    expect(dispatchName(context, 'shared.bin', false)).toBe(-1);
    expect(dispatchName(context, 'shared.bin', false)).toBe(-1);
    const suspended = dispatchName(context, 'shared.bin', true) as Promise<number>;
    expect(context.takePending()).toHaveLength(1);
    expect(context.takePending()).toEqual([]);
    release?.(new Uint8Array([9]));
    const handle = await suspended;
    expect(handle).toBeGreaterThan(0);
    expect(dispatchName(context, 'shared.bin', false)).toBeGreaterThan(0);
  });

  const request = (resolve?: PreparedConversion<readonly [{ readonly to: 'glb' }]>['resolve']) =>
    prepareConversion(
      { name: 'cube.obj', bytes: cube },
      {
        targets: [{ to: 'glb' }] as const,
        ...(resolve === undefined ? {} : { resolve }),
      },
      new Set(['glb']),
    );

  const runtime = (overrides: Partial<NativeRuntime['native']> & { runPlan: NativeRuntime['runPlan'] }) => {
    const destroyed: number[] = [];
    const value: NativeRuntime = {
      native: {
        _libassimp_run_plan: () => 0,
        preparePlan: () => 7,
        takePlanResult: () => ({ ok: true, code: '', message: '', formats: [{ format: 'glb', files: [] }] }),
        destroyPlan: (handle) => destroyed.push(handle),
        ...overrides,
      },
      runPlan: overrides.runPlan,
    };
    return { destroyed, value };
  };

  it('rejects replay without new resolver work and always destroys the plan', async () => {
    const { destroyed, value } = runtime({ runPlan: async () => -1 });
    await expect(runPreparedConversion(value, request())).rejects.toThrow(
      'PENDING without new resolver work',
    );
    expect(destroyed).toEqual([7]);
  });

  it('maps a resolver rejection that settles between replay attempts', async () => {
    const cause = new Error('offline');
    const { destroyed, value } = runtime({
      runPlan: async (_handle, context) => {
        void dispatchName(context, 'late.bin', false);
        return -1;
      },
    });
    await expect(
      runPreparedConversion(
        value,
        request(async () => Promise.reject(cause)),
      ),
    ).rejects.toMatchObject({
      code: 'RESOLVE_FAILED',
      fileName: 'late.bin',
      cause,
    });
    expect(destroyed).toEqual([7]);
  });

  it.each([
    [{}, {}],
    [
      { formatIndex: 2, format: 'stl' },
      { formatIndex: 2, format: 'stl' },
    ],
  ] as const)('maps native failure context atomically', async (context, expected) => {
    const { value } = runtime({
      runPlan: async () => 0,
      takePlanResult: () => ({
        ok: false,
        code: 'EXPORT_FAILED',
        message: 'failed',
        formats: [],
        ...context,
      }),
    });
    await expect(runPreparedConversion(value, request())).rejects.toMatchObject({
      code: 'EXPORT_FAILED',
      ...expected,
    });
  });
});

describe('instance route parity', () => {
  it('produces exact normal-JSPI and forced-replay output with one resolver call', async () => {
    const wasm = WebAssembly as typeof WebAssembly & {
      readonly Suspending?: unknown;
      readonly promising?: unknown;
    };
    const descriptors = {
      Suspending: Object.getOwnPropertyDescriptor(WebAssembly, 'Suspending'),
      promising: Object.getOwnPropertyDescriptor(WebAssembly, 'promising'),
    };
    expect(typeof wasm.Suspending).toBe('function');
    expect(typeof wasm.promising).toBe('function');
    const asked: string[][] = [[], []];
    const run = async (index: number) => {
      using assimp = await createAssimp();
      return await assimp.convert(
        { name: 'cube_usemtl.obj', bytes: model('OBJ/cube_usemtl.obj') },
        {
          to: 'glb',
          resolve: async (name) => {
            asked[index]?.push(name);
            return name.endsWith('.mtl') ? model('OBJ/cube_usemtl.mtl') : undefined;
          },
        },
      );
    };
    const jspi = await run(0);
    try {
      Reflect.deleteProperty(WebAssembly, 'Suspending');
      Reflect.deleteProperty(WebAssembly, 'promising');
      const replay = await run(1);
      expect(replay.files).toEqual(jspi.files);
    } finally {
      if (descriptors.Suspending !== undefined) {
        Object.defineProperty(WebAssembly, 'Suspending', descriptors.Suspending);
      }
      if (descriptors.promising !== undefined) {
        Object.defineProperty(WebAssembly, 'promising', descriptors.promising);
      }
    }
    expect(asked[0]).toEqual(asked[1]);
    expect(asked[0]?.filter((name) => name === 'cube_usemtl.mtl')).toHaveLength(1);
  });
});
