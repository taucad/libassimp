import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { AssimpError } from './assimp-error.js';
import { validatePlanOptions } from './assimp-options.js';
import {
  prepareConversion,
  ResolutionContext,
  runPreparedConversion,
  unsignedWasmI32,
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
    [{ targets: [{ to: 'glb' }], postProcess: ['toString'] }, 'unknown step'],
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
    [{ importGlobalKeyframe: 2_147_483_648 }, 'expected signed 32-bit integer'],
    [{ globalScaleFactorKey: Number.POSITIVE_INFINITY }, 'expected finite number'],
    [{ globalScaleFactorKey: 1e300 }, 'expected finite float32 number'],
    [{ importOgreMaterialFile: 1 }, 'expected string'],
    [{ ppPtvRootTransformation: 'matrix' }, 'expected 16 finite numbers'],
    [{ ppPtvRootTransformation: Array.from({ length: 15 }, () => 0) }, 'expected 16 finite numbers'],
    [
      { ppPtvRootTransformation: [...Array.from({ length: 15 }, () => 0), Number.NaN] },
      'expected 16 finite numbers',
    ],
    [
      { ppPtvRootTransformation: [...Array.from({ length: 15 }, () => 0), 1e300] },
      'expected 16 finite float32 numbers',
    ],
    [{ '3dsUpAxis': 'q' }, 'expected one of x, y, z'],
  ] as const)('validates every generated import storage shape', (importOptions, message) => {
    expect(() => validatePlanOptions({ targets: [{ to: 'glb' }], importOptions }, new Set(['glb']))).toThrow(
      message,
    );
  });

  it('accepts a representable finite float32 import value', () => {
    expect(() =>
      validatePlanOptions(
        { targets: [{ to: 'glb' }], importOptions: { globalScaleFactorKey: 1 } },
        new Set(['glb']),
      ),
    ).not.toThrow();
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

  it('routes format variants without emitting route sentinels as native properties', () => {
    const plan = validatePlanOptions(
      {
        targets: [
          { to: 'fbx', exportOptions: { binary: false } },
          { to: 'obj', exportOptions: { materials: false } },
          { to: 'ply', exportOptions: { binary: true } },
          { to: 'stl', exportOptions: { binary: true } },
        ],
      },
      new Set(['fbx', 'obj', 'ply', 'stl']),
    );
    expect(plan.targets.map(({ nativeId }) => nativeId)).toEqual(['fbxa', 'objnomtl', 'plyb', 'stlb']);
    expect(
      plan.targets
        .flatMap(({ properties }) => properties.map(({ name }) => name))
        .filter((name) => name.startsWith('@route/')),
    ).toEqual([]);
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

  it('throws an already-aborted reason before reading plan inputs', () => {
    const controller = new AbortController();
    const reason = { phase: 'before-plan' };
    const targets = vi.fn();
    controller.abort(reason);
    const options = Object.defineProperties(
      { signal: controller.signal },
      { targets: { get: targets } },
    ) as never;
    let thrown: unknown;
    try {
      prepareConversion({ name: 'cube.obj', bytes: cube }, options, new Set(['glb']));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(reason);
    expect(targets).not.toHaveBeenCalled();
  });

  it('rejects typed-array proxies before staging input bytes', () => {
    const file = { name: 'cube.obj', bytes: new Proxy(cube, {}) };
    expect(() => prepareConversion(file, { targets: [{ to: 'glb' }] }, new Set(['glb']))).toThrow(
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

  it('normalizes signed JavaScript i32 values at the Wasm boundary', () => {
    expect(unsignedWasmI32(0)).toBe(0);
    expect(unsignedWasmI32(-1)).toBe(0xffff_ffff);
    expect(unsignedWasmI32(-2_147_483_648)).toBe(0x8000_0000);
  });

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
    expect(ready.dispatch({ operation: 4, first: handle, second: 0, memory, suspending: false })).toBe(0);
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

    const direct = new ResolutionContext(async () => new Uint8Array([8]));
    await expect(dispatchName(direct, 'direct.bin', true)).resolves.toBeGreaterThan(0);
  });

  it('preserves a throwing then getter as a resolver failure', () => {
    const cause = new Error('invalid resolver promise');
    const context = new ResolutionContext(
      () =>
        // oxlint-disable-next-line unicorn/no-thenable -- hostile resolver results must preserve their failure cause.
        Object.defineProperty({}, 'then', {
          get() {
            throw cause;
          },
        }) as Promise<Uint8Array>,
    );
    expect(context.resolve('broken.bin')).toEqual({ status: 'failed' });
    expect(context.getFailure()).toEqual({ fileName: 'broken.bin', cause });
    context.dispose();
  });

  it.each([false, true])(
    'releases copied Wasm sidecar state before plan completion (JSPI: %s)',
    async (suspending) => {
      const bytes = new Uint8Array([3, 4]);
      const context = new ResolutionContext(async () => bytes);
      let handle = await dispatchName(context, 'copied.bin', suspending);
      if (!suspending) {
        await Promise.all(context.takePending());
        handle = await dispatchName(context, 'copied.bin', false);
      }
      expect(Reflect.get(context, 'states')).toHaveProperty('size', 1);
      expect(context.dispatch({ operation: 3, first: handle, second: 64, memory, suspending })).toBe(2);
      expect(context.dispatch({ operation: 4, first: handle, second: 0, memory, suspending })).toBe(0);
      expect(Reflect.get(context, 'states')).toEqual(new Map());
      expect(Reflect.get(context, 'handles')).toEqual(new Map());
      context.dispose();
    },
  );

  it('does not allocate Wasm handles while a Promise merely settles', async () => {
    const bytes = new Uint8Array([7]);
    const context = new ResolutionContext(async () => bytes);
    await expect(context.resolve('shared.bin')).resolves.toEqual({ status: 'found', bytes });
    expect(dispatchName(context, 'shared.bin', false)).toBe(1);
  });

  it('disposes pending work and ignores late settlement', async () => {
    let resolve: ((bytes: Uint8Array) => void) | undefined;
    const context = new ResolutionContext(
      () =>
        new Promise((settle) => {
          resolve = settle;
        }),
    );
    const pending = dispatchName(context, 'late.bin', true) as Promise<number>;
    context.dispose();
    context.dispose();
    expect(Reflect.get(context, 'resolver')).toBeUndefined();
    resolve?.(new Uint8Array([9]));
    await expect(pending).resolves.toBe(-1);
    await Promise.resolve();
    expect(dispatchName(context, 'late.bin', false)).toBe(-1);
    expect(context.takePending()).toEqual([]);
    expect(context.getFailure()).toBeUndefined();
  });

  it('closes pending work on abort and preserves the exact reason', async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    let reject: ((cause: unknown) => void) | undefined;
    const context = new ResolutionContext(
      () =>
        new Promise((_resolve, rejectPromise) => {
          reject = rejectPromise;
        }),
      controller.signal,
    );
    const pending = dispatchName(context, 'late.bin', true) as Promise<number>;
    const reason = { phase: 'resolving' };
    controller.abort(reason);
    expect(Reflect.get(context, 'resolver')).toBeUndefined();
    await expect(pending).resolves.toBe(-1);
    let thrown: unknown;
    try {
      context.throwIfAborted();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(reason);
    expect(add).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(context.resolve('after-abort.bin')).toEqual({ status: 'aborted' });
    reject?.(new Error('late rejection'));
    await Promise.resolve();
    expect(context.getFailure()).toBeUndefined();
    expect(context.takePending()).toEqual([]);
    context.dispose();
  });

  it('fences a settled Promise before its Wasm continuation can allocate', async () => {
    const controller = new AbortController();
    const context = new ResolutionContext(async () => new Uint8Array([5]), controller.signal);
    const pending = dispatchName(context, 'raced.bin', true) as Promise<number>;
    await Promise.resolve();
    controller.abort('closed generation');
    await expect(pending).resolves.toBe(-1);
    context.dispose();
  });

  it('does not reopen when a resolver aborts synchronously', async () => {
    const reason = { phase: 'inside-resolver' };
    for (const finish of [
      () => Promise.reject(new Error('late rejection')),
      () => {
        throw new Error('late throw');
      },
    ]) {
      const controller = new AbortController();
      const context = new ResolutionContext(() => {
        controller.abort(reason);
        return finish();
      }, controller.signal);
      expect(dispatchName(context, 'raced.bin', true)).toBe(-1);
      await Promise.resolve();
      expect(context.getFailure()).toBeUndefined();
      expect(context.takePending()).toEqual([]);
      context.dispose();
    }
  });

  const request = (
    resolve?: PreparedConversion<readonly [{ readonly to: 'glb' }]>['resolve'],
    signal?: AbortSignal,
  ) =>
    prepareConversion(
      { name: 'cube.obj', bytes: cube },
      {
        targets: [{ to: 'glb' }] as const,
        ...(resolve === undefined ? {} : { resolve }),
        ...(signal === undefined ? {} : { signal }),
      },
      new Set(['glb']),
    );

  const runtime = (
    overrides: Partial<Pick<NativeRuntime, 'destroyPlan' | 'preparePlan' | 'takePlanResult'>> & {
      runPlan: NativeRuntime['runPlan'];
    },
  ) => {
    const destroyed: number[] = [];
    const cancelled: number[] = [];
    const { runPlan, ...nativeOverrides } = overrides;
    const value: NativeRuntime = {
      backend: 'wasm',
      preparePlan: () => 7,
      takePlanResult: () => ({ ok: true, code: '', message: '', formats: [{ format: 'glb', files: [] }] }),
      destroyPlan: (handle) => destroyed.push(handle as number),
      cancelPlan: (handle) => cancelled.push(handle as number),
      dispose: () => undefined,
      ...nativeOverrides,
      runPlan,
    };
    return { cancelled, destroyed, value };
  };

  it('preserves an abort reason at admission without preparing a plan', async () => {
    const controller = new AbortController();
    const reason = { phase: 'admission' };
    const preparedRequest = request(undefined, controller.signal);
    controller.abort(reason);
    const preparePlan = vi.fn(() => 7);
    const dispose = vi.spyOn(ResolutionContext.prototype, 'dispose');
    const { destroyed, value } = runtime({ preparePlan, runPlan: async () => 1 });
    await expect(runPreparedConversion(value, preparedRequest)).rejects.toBe(reason);
    expect(preparePlan).not.toHaveBeenCalled();
    expect(destroyed).toEqual([]);
    expect(dispose).toHaveBeenCalledOnce();
    dispose.mockRestore();
  });

  it('cancels resolving work and cleans up exactly once', async () => {
    const controller = new AbortController();
    const reason = { phase: 'resolver' };
    const dispose = vi.spyOn(ResolutionContext.prototype, 'dispose');
    const { cancelled, destroyed, value } = runtime({
      runPlan: async (_handle, context) => {
        void dispatchName(context, 'slow.bin', false);
        queueMicrotask(() => {
          controller.abort(reason);
        });
        return -1;
      },
    });
    await expect(
      runPreparedConversion(
        value,
        request(() => new Promise(() => undefined), controller.signal),
      ),
    ).rejects.toBe(reason);
    expect(cancelled).toEqual([7]);
    expect(destroyed).toEqual([7]);
    expect(dispose).toHaveBeenCalledOnce();
    dispose.mockRestore();
  });

  it('cancels a plan when its signal aborts during preparation', async () => {
    const controller = new AbortController();
    const reason = { phase: 'prepare' };
    const preparedRequest = request(undefined, controller.signal);
    const { cancelled, destroyed, value } = runtime({
      preparePlan: () => {
        controller.abort(reason);
        return 7;
      },
      runPlan: async () => 1,
    });
    await expect(runPreparedConversion(value, preparedRequest)).rejects.toBe(reason);
    expect(cancelled).toEqual([7]);
    expect(destroyed).toEqual([7]);
  });

  it('preserves a run rejection and still destroys its plan', async () => {
    const cause = new Error('runtime failed');
    const { destroyed, value } = runtime({
      runPlan: async () => Promise.reject(cause),
    });
    await expect(runPreparedConversion(value, request())).rejects.toBe(cause);
    expect(destroyed).toEqual([7]);
  });

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
  it.skipIf(
    typeof (WebAssembly as typeof WebAssembly & { readonly Suspending?: unknown }).Suspending !==
      'function' ||
      typeof (WebAssembly as typeof WebAssembly & { readonly promising?: unknown }).promising !== 'function',
  )('produces exact normal-JSPI and forced-replay output with one resolver call', async () => {
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
