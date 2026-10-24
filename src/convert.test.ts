import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { AssimpError } from './assimp-error.js';
import { validatePlanOptions } from './assimp-options.js';
import {
  prepareConversion,
  ResolutionContext,
  runPreparedConversion,
  engineFailure,
  HostOutput,
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

const NativeArrayBuffer = ArrayBuffer;
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
    expect(results.map(({ files }) => files[0]?.name)).toEqual(['cube.glb', 'cube.stl', 'cube.stl']);
    expect(results[1].files[0]?.bytes).not.toEqual(results[2].files[0]?.bytes);
  });

  it('keeps singular output byte-identical to a one-target plan', async () => {
    const singular = await convert({ name: 'cube.obj', bytes: cube }, { to: 'gltf' });
    const [plural] = await convertFormats({ name: 'cube.obj', bytes: cube }, { targets: [{ to: 'gltf' }] });
    expect(plural.files).toEqual(singular.files);
    expect(plural.files.map(({ name }) => name)).toEqual(['cube.gltf', 'cube.bin']);
  });

  it('passes all provided source and sidecar files', async () => {
    const files = [
      { name: 'cube_usemtl.obj', bytes: model('OBJ/cube_usemtl.obj') },
      { name: 'cube_usemtl.mtl', bytes: model('OBJ/cube_usemtl.mtl') },
    ];
    const result = await convert(files, { to: 'glb' });
    expect(primary(result).name).toBe('cube_usemtl.glb');
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
    expect(primary(result).name).toBe('cube_usemtl.glb');
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
    expect(withMaterials.files.map(({ name }) => name)).toContain('cube_usemtl.mtl');
    expect(withoutMaterials.files.map(({ name }) => name)).toEqual(['cube_usemtl.obj']);
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
    expect(primary(result).name).toBe('cube.glb');
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
      'modern.glb',
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
    [{ aseUpAxis: 'q' }, 'expected one of x, y, z'],
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
        importOptions: { favourSpeed: true, aseUpAxis: 'x', ppPtvRootTransformation: matrix },
      },
      new Set(['3mf']),
    );
    expect(plan.importProperties).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'FAVOUR_SPEED', kind: 'integer', value: 1 }),
        expect.objectContaining({ name: 'IMPORT_ASE_UP_AXIS', kind: 'integer', value: 0 }),
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
    overrides: Partial<
      Pick<NativeRuntime, 'backend' | 'destroyPlan' | 'peakMemoryBytes' | 'preparePlan' | 'takePlanResult'>
    > & {
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
      peakMemoryBytes: () => 42,
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

  it('wraps a run rejection as ENGINE_FAILED and leaves the trapped plan alone', async () => {
    const cause = new Error('unreachable executed');
    const { destroyed, value } = runtime({
      runPlan: async () => Promise.reject(cause),
    });
    const error = await failure(runPreparedConversion(value, request()));
    expect(error).toMatchObject({ code: 'ENGINE_FAILED', cause });
    expect(error.message).toBe(
      'The wasm engine failed: unreachable executed. The Wasm runtime was discarded; the next conversion starts a fresh one.',
    );
    expect(destroyed).toEqual([]);
  });

  it('wraps throws from plan preparation and result handover, but keeps typed errors', async () => {
    const typed = new AssimpError('INVALID_OPTIONS', 'nested');
    const prepareTyped = runtime({
      preparePlan: () => {
        throw typed;
      },
      runPlan: async () => 1,
    });
    await expect(runPreparedConversion(prepareTyped.value, request())).rejects.toBe(typed);
    const prepareRaw = runtime({
      backend: 'native',
      preparePlan: () => {
        throw 'bad_alloc';
      },
      runPlan: async () => 1,
    });
    const prepared = await failure(runPreparedConversion(prepareRaw.value, request()));
    expect(prepared).toMatchObject({
      code: 'ENGINE_FAILED',
      cause: 'bad_alloc',
      message: 'The native engine failed: bad_alloc.',
    });
    const take = runtime({
      runPlan: async () => 1,
      takePlanResult: () => {
        throw new RangeError('table index is out of bounds');
      },
    });
    await expect(runPreparedConversion(take.value, request())).rejects.toMatchObject({
      code: 'ENGINE_FAILED',
    });
    expect(take.destroyed).toEqual([]);
    expect(engineFailure('wasm', typed)).toBe(typed);
  });

  it('rejects replay without new resolver work as INTERNAL and destroys the plan', async () => {
    const { destroyed, value } = runtime({ runPlan: async () => -1 });
    const error = await failure(runPreparedConversion(value, request()));
    expect(error.code).toBe('INTERNAL');
    expect(error.message).toContain('replay without new resolver work');
    expect(destroyed).toEqual([7]);
  });

  it('reports an engine-side stop without a signal abort as ABORTED', async () => {
    const { destroyed, value } = runtime({ runPlan: async () => 3 });
    await expect(runPreparedConversion(value, request())).rejects.toMatchObject({ code: 'ABORTED' });
    expect(destroyed).toEqual([7]);
  });

  it.each([
    [
      { code: 'LIMIT_EXCEEDED', message: '' },
      'wasm',
      "The conversion ran out of memory while importing 'cube.obj'. A Wasm instance is limited to 4 GiB; split the input, request fewer post-processing steps, or use the native backend on Node.js.",
    ],
    [
      { code: 'LIMIT_EXCEEDED', message: 'std::bad_alloc', formatIndex: 0, format: 'glb' },
      'native',
      'The conversion ran out of memory while exporting glb (std::bad_alloc). Free memory on the host or split the input.',
    ],
    [
      { code: 'IMPORT_FAILED', message: '' },
      'wasm',
      "assimp could not import 'cube.obj' and gave no reason.",
    ],
    [
      { code: 'EXPORT_FAILED', message: '', formatIndex: 0, format: 'glb' },
      'wasm',
      "assimp's glb exporter failed and gave no reason.",
    ],
    [
      { code: 'RESOLVE_FAILED', message: '' },
      'wasm',
      'The conversion failed with RESOLVE_FAILED and no message.',
    ],
    [{ code: 'IMPORT_FAILED', message: 'bad header' }, 'wasm', 'bad header'],
  ] as const)('writes a useful message for engine failure %#', async (context, backend, message) => {
    const { value } = runtime({
      backend,
      runPlan: async () => 0,
      takePlanResult: () => ({ ok: false, formats: [], ...context }),
    });
    await expect(runPreparedConversion(value, request())).rejects.toMatchObject({
      code: context.code,
      message,
    });
  });

  it('maps an unknown engine failure code to INTERNAL with its context', async () => {
    const { value } = runtime({
      runPlan: async () => 0,
      takePlanResult: () => ({
        ok: false,
        code: 'MYSTERY' as 'INTERNAL',
        message: 'what',
        formatIndex: 0,
        format: 'glb',
        formats: [],
      }),
    });
    const error = await failure(runPreparedConversion(value, request()));
    expect(error).toMatchObject({ code: 'INTERNAL', formatIndex: 0, format: 'glb' });
    expect(error.message).toContain("'MYSTERY' (what)");
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

describe('streamed output, progress, and the conversion report', () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const words = (offset: number, values: readonly number[], signed = false): number => {
    (signed
      ? new Int32Array(memory.buffer, offset, values.length)
      : new Uint32Array(memory.buffer, offset, values.length)
    ).set(values);
    return offset;
  };
  const writeChunk = (
    context: ResolutionContext,
    file: number,
    { offset, bytes }: { readonly offset: number; readonly bytes: readonly number[] },
  ): number => {
    new Uint8Array(memory.buffer, 1024, bytes.length).set(bytes);
    return context.dispatch({
      operation: 5,
      first: words(0, [file, 1024, bytes.length, offset]),
      second: 0,
      memory,
      suspending: false,
    }) as number;
  };
  const reportProgress = (context: ResolutionContext, values: readonly number[]): unknown =>
    context.dispatch({ operation: 6, first: words(64, values, true), second: 0, memory, suspending: false });

  const request = (onProgress?: (progress: unknown) => void) =>
    prepareConversion(
      { name: 'models/chair.obj', bytes: cube },
      {
        targets: [{ to: 'glb' }, { to: 'stl' }] as const,
        ...(onProgress === undefined ? {} : { onProgress }),
      },
      new Set(['glb', 'stl']),
    );

  it('names outputs after the entry stem with the canonical extension', () => {
    const name = (entry: string, to = 'step'): string | undefined =>
      validatePlanOptions({ targets: [{ to }] }, new Set([to]), entry).targets[0]?.outputName;
    expect(name('chair.obj')).toBe('chair.step');
    expect(name('dir/sub\\part.v2.STEP', 'glb')).toBe('part.v2.glb');
    expect(name('noext')).toBe('noext.step');
    expect(name('.hidden')).toBe('.hidden.step');
    expect(name('dir/')).toBe('result.step');
    expect(validatePlanOptions({ targets: [{ to: 'glb' }] }, new Set(['glb'])).targets[0]?.outputName).toBe(
      'result.glb',
    );
  });

  it('rejects empty and repeated input names and a non-function progress listener', () => {
    const options = { targets: [{ to: 'glb' }] } as const;
    const invalid = (files: readonly AssimpFile[], extra: object = {}): AssimpError => {
      try {
        prepareConversion(files, { ...options, ...extra }, new Set(['glb']));
      } catch (error) {
        return error as AssimpError;
      }
      throw new Error('expected a validation failure');
    };
    const empty = invalid([{ name: '', bytes: cube }]);
    expect(empty).toMatchObject({ code: 'INVALID_OPTIONS' });
    expect(empty.message).toContain('files[0].name: expected a non-empty name');
    const repeated = invalid([
      { name: 'a.obj', bytes: cube },
      { name: 'a.mtl', bytes: cube },
      { name: 'a.obj', bytes: cube },
    ]);
    expect(repeated).toMatchObject({ code: 'INVALID_OPTIONS' });
    expect(repeated.message).toContain("files[2].name: 'a.obj' repeats an earlier file");
    const listener = invalid([{ name: 'a.obj', bytes: cube }], { onProgress: 'yes' });
    expect(listener).toMatchObject({
      code: 'INVALID_OPTIONS',
      message: expect.stringContaining('onProgress'),
    });
  });

  it('assembles streamed chunks in place, patches earlier bytes, and releases them on handover', () => {
    const context = new ResolutionContext(undefined);
    expect(writeChunk(context, 1, { offset: 0, bytes: [1, 2, 3] })).toBe(0);
    expect(writeChunk(context, 1, { offset: 3, bytes: [4, 5] })).toBe(0);
    expect(writeChunk(context, 1, { offset: 1, bytes: [9] })).toBe(0);
    expect(writeChunk(context, 2, { offset: 0, bytes: [7] })).toBe(0);
    const first = context.takeOutput(1, 6);
    expect([...first]).toEqual([1, 9, 3, 4, 5, 0]);
    expect(first.buffer.byteLength).toBe(6);
    expect([...context.takeOutput(1, 2)]).toEqual([0, 0]);
    context.resetOutputs();
    expect([...context.takeOutput(2, 1)]).toEqual([0]);
    expect(writeChunk(context, 3, { offset: 0, bytes: [1] })).toBe(0);
    context.dispose();
    expect([...context.takeOutput(3, 0)]).toEqual([]);
    expect(context.getOutputFailure()).toBeUndefined();
  });

  it('grows a resizable output past its reservation without copying the finished bytes', () => {
    const output = new HostOutput(4);
    output.write(0, new Uint8Array([1, 2, 3, 4]));
    output.write(4, new Uint8Array([5, 6, 7, 8, 9]));
    const bytes = output.take(9, true);
    expect([...bytes]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(bytes.buffer.resizable).toBe(true);
    expect(bytes.buffer.maxByteLength).toBe(4 * 1024 * 1024 * 1024);
    expect(new HostOutput(16).take(3, true).byteLength).toBe(3);
  });

  it('transfers a finished resizable output to a fixed-length buffer by default', () => {
    const output = new HostOutput(4);
    output.write(0, new Uint8Array([1, 2, 3]));
    const bytes = output.take(5);
    expect([...bytes]).toEqual([1, 2, 3, 0, 0]);
    expect(bytes.buffer.resizable).toBe(false);
    expect(bytes.buffer.byteLength).toBe(5);
    expect(new TextDecoder().decode(bytes.subarray(0, 3))).toBe('\u0001\u0002\u0003');
  });

  it.each([
    ['ignores maxByteLength', (length: number) => new NativeArrayBuffer(length)],
    [
      'rejects maxByteLength',
      (length: number, options?: object) => {
        if (options !== undefined) throw new TypeError('resizable buffers are unsupported');
        return new NativeArrayBuffer(length);
      },
    ],
  ])('falls back to geometric growth when the host %s', (_label, construct) => {
    vi.stubGlobal('ArrayBuffer', function (length: number, options?: object) {
      return construct(length, options);
    });
    try {
      const output = new HostOutput();
      output.write(0, new Uint8Array([1, 2]));
      output.write(2, new Uint8Array([3]));
      output.write(3, new Uint8Array([4]));
      const exact = output.take(4);
      expect([...exact]).toEqual([1, 2, 3, 4]);
      expect(exact.buffer.resizable).toBe(false);
      const sliced = new HostOutput();
      sliced.write(0, new Uint8Array([1, 2]));
      sliced.write(2, new Uint8Array([3]));
      const copy = sliced.take(3);
      expect([...copy]).toEqual([1, 2, 3]);
      expect(copy.buffer.byteLength).toBe(3);
      expect([...new HostOutput().take(2)]).toEqual([0, 0]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports an output the host cannot hold as LIMIT_EXCEEDED', async () => {
    const tooFar = 4 * 1024 * 1024 * 1024 + 1;
    const value: NativeRuntime = {
      backend: 'wasm',
      preparePlan: () => 1,
      runPlan: async (_handle, context) => {
        expect(context.writeOutput(1, tooFar, new Uint8Array([1]))).toBe(-1);
        expect(context.writeOutput(1, tooFar + 1, new Uint8Array([1]))).toBe(-1);
        return 1;
      },
      cancelPlan: () => undefined,
      takePlanResult: () => ({ ok: true, code: '', message: '', formats: [] }),
      destroyPlan: () => undefined,
      dispose: () => undefined,
      peakMemoryBytes: () => 0,
    };
    const error = await failure(runPreparedConversion(value, request()));
    expect(error.code).toBe('LIMIT_EXCEEDED');
    expect(error.message).toContain('could not hold the converted output');
    expect(error.cause).toBeInstanceOf(RangeError);
  });

  it('delivers progress by phase, swallows listener errors, and stops after disposal', () => {
    const reports: unknown[] = [];
    const context = new ResolutionContext(undefined, undefined, {
      onProgress: (progress) => {
        reports.push(progress);
        if (progress.phase === 'postProcess') throw new Error('listener bug');
      },
      formats: ['glb', 'stl'],
    });
    expect(context.reportsProgress()).toBe(true);
    expect(reportProgress(context, [1, 5, 10, -1])).toBe(0);
    reportProgress(context, [2, 3, 30, -1]);
    reportProgress(context, [3, 4, 4, 1]);
    context.dispose();
    reportProgress(context, [1, 10, 10, -1]);
    expect(reports).toEqual([
      { phase: 'import', step: 5, total: 10 },
      { phase: 'postProcess', step: 3, total: 30 },
      { phase: 'export', step: 4, total: 4, formatIndex: 1, format: 'stl' },
    ]);
    const silent = new ResolutionContext(undefined);
    expect(silent.reportsProgress()).toBe(false);
    reportProgress(silent, [1, 0, 1, -1]);
    silent.dispose();
  });

  it('returns streamed and native bytes with warnings, timings, and the memory high-water mark', async () => {
    const reports: unknown[] = [];
    const value: NativeRuntime = {
      backend: 'wasm',
      preparePlan: (_entry, _files, options) => {
        expect(options.progress).toBe(true);
        expect(options.targets.map(({ outputName }) => outputName)).toEqual(['chair.glb', 'chair.stl']);
        return 1;
      },
      runPlan: async (_handle, context) => {
        writeChunk(context, 1, { offset: 0, bytes: [0x67, 0x6c] });
        reportProgress(context, [3, 1, 4, 0]);
        return 1;
      },
      cancelPlan: () => undefined,
      takePlanResult: () => ({
        ok: true,
        code: '',
        message: '',
        formats: [
          { format: 'glb', files: [{ name: 'chair.glb', hostFile: 1, size: 2 }] },
          { format: 'stl', files: [{ name: 'chair.stl', bytes: new Uint8Array([5]) }] },
        ],
        warnings: [
          {
            error: false,
            phase: 1,
            formatIndex: -1,
            message: 'OBJ: no name for material library specified.',
          },
          { error: true, phase: 2, formatIndex: -1, message: 'degenerate face' },
          { error: false, phase: 3, formatIndex: 1, message: 'binary STL' },
        ],
        timings: { import: 1.5, postProcess: 0.25, export: 2 },
      }),
      destroyPlan: () => undefined,
      dispose: () => undefined,
      peakMemoryBytes: () => 65_536,
    };
    const result = await runPreparedConversion(
      value,
      request((progress) => reports.push(progress)),
    );
    expect(result.map(({ files }) => files.map(({ name, bytes }) => [name, [...bytes]]))).toEqual([
      [['chair.glb', [0x67, 0x6c]]],
      [['chair.stl', [5]]],
    ]);
    expect(result.warnings).toEqual([
      { severity: 'warning', phase: 'import', message: 'OBJ: no name for material library specified.' },
      { severity: 'error', phase: 'postProcess', message: 'degenerate face' },
      { severity: 'warning', phase: 'export', message: 'binary STL', formatIndex: 1, format: 'stl' },
    ]);
    expect(Object.keys(result.warnings[0] ?? {})).not.toContain('formatIndex');
    expect(result.timings).toEqual({ import: 1.5, postProcess: 0.25, export: 2, total: expect.any(Number) });
    expect(result.timings.total).toBeGreaterThanOrEqual(0);
    expect(result.peakMemoryBytes).toBe(65_536);
    expect(reports).toEqual([{ phase: 'export', step: 1, total: 4, formatIndex: 0, format: 'glb' }]);
  });

  it('leaves unset error context absent rather than undefined', () => {
    const bare = new AssimpError('INTERNAL', 'x');
    expect(Object.keys(bare).toSorted()).toEqual(['code', 'name']);
    expect('formatIndex' in bare).toBe(false);
    expect('cause' in bare).toBe(false);
    const full = new AssimpError('EXPORT_FAILED', 'y', {
      formatIndex: 0,
      format: 'glb',
      fileName: 'a',
      cause: 1,
    });
    expect(full).toMatchObject({ formatIndex: 0, format: 'glb', fileName: 'a', cause: 1 });
  });
});

describe('engine diagnostics and resource limits on the real Wasm runtime', () => {
  const header = (vertices: number, padding = 0): Uint8Array => {
    const text = `ply\nformat ascii 1.0\nelement vertex ${vertices}\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n`;
    const encoded = new TextEncoder().encode(text);
    const bytes = new Uint8Array(encoded.length + padding);
    bytes.set(encoded);
    bytes.fill(0x20, encoded.length);
    return bytes;
  };

  it('reports an allocation failure as LIMIT_EXCEEDED and keeps the instance working', async () => {
    await using assimp = await createAssimp({ recycleAboveBytes: Number.POSITIVE_INFINITY });
    // 357 million float3 vertices need ~4.28 GB: below the 32-bit size limit, above what Wasm can grow to.
    const error = await failure(
      assimp.convert({ name: 'huge.ply', bytes: header(357_000_000) }, { to: 'stl' }),
    );
    expect(error.code).toBe('LIMIT_EXCEEDED');
    expect(error.message).toContain("importing 'huge.ply'");
    expect(error.message).toContain('4 GiB');
    expect('formatIndex' in error).toBe(false);
    const after = await assimp.convert({ name: 'cube.obj', bytes: cube }, { to: 'stl' });
    expect(after.files.map(({ name }) => name)).toEqual(['cube.stl']);
  });

  it('keeps linear memory flat across repeated failing conversions', async () => {
    await using assimp = await createAssimp({ recycleAboveBytes: Number.POSITIVE_INFINITY });
    const memoryBytes = Reflect.get(assimp, Symbol.for('libassimp.memoryBytes')) as () => number;
    const broken = new Uint8Array(4 * 1024 * 1024).fill(0x78);
    broken.set(new TextEncoder().encode('ply\nformat ascii 1.0\nelement vertex x\n'));
    const fail = async (): Promise<void> => {
      await failure(assimp.convert({ name: 'broken.ply', bytes: broken }, { to: 'stl' }));
      await failure(
        assimp.convert({ name: 'huge.ply', bytes: header(357_000_000, 1024 * 1024) }, { to: 'stl' }),
      );
      await failure(
        assimp.convert(
          { name: 'cube_usemtl.obj', bytes: model('OBJ/cube_usemtl.obj') },
          { to: 'glb', resolve: async () => Promise.reject(new Error('offline')) },
        ),
      );
    };
    for (let index = 0; index < 3; index += 1) await fail();
    const settled = memoryBytes();
    // Each round stages 5 MiB of input; a per-call leak would grow memory by at least that much.
    for (let index = 0; index < 30; index += 1) await fail();
    expect(memoryBytes()).toBe(settled);
  });

  it('collects assimp warnings with a cap and a count of the rest', async () => {
    const source = `${'mtllib\n'.repeat(70)}v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n`;
    const result = await convert(
      { name: 'noisy.obj', bytes: new TextEncoder().encode(source) },
      { to: 'ply' },
    );
    expect(result.files.map(({ name }) => name)).toEqual(['noisy.ply']);
    expect(result.warnings).toHaveLength(65);
    expect(result.warnings[0]).toEqual({
      severity: 'warning',
      phase: 'import',
      message: expect.stringContaining('no name for material library'),
    });
    const omitted = /^(\d+) more assimp messages were omitted\.$/u.exec(
      result.warnings.at(-1)?.message ?? '',
    );
    expect(Number(omitted?.[1])).toBeGreaterThanOrEqual(6);
  });

  it('reports progress, timings, and peak memory for a real conversion', async () => {
    const reports: { phase: string; step: number; total: number; formatIndex?: number }[] = [];
    const result = await convertFormats(
      { name: 'cube.obj', bytes: cube },
      { targets: [{ to: 'glb' }, { to: 'stl' }], onProgress: (progress) => reports.push(progress) },
    );
    expect(result.map(({ files }) => files[0]?.name)).toEqual(['cube.glb', 'cube.stl']);
    expect(reports[0]).toMatchObject({ phase: 'import', step: 0 });
    expect(reports.some(({ phase }) => phase === 'postProcess')).toBe(true);
    expect(reports.filter(({ phase }) => phase === 'export').map(({ formatIndex }) => formatIndex)).toContain(
      1,
    );
    expect(reports.at(-1)).toMatchObject({ phase: 'export', formatIndex: 1, format: 'stl' });
    for (const { step, total } of reports) expect(step).toBeLessThanOrEqual(total);
    expect(Array.isArray(result.warnings)).toBe(true);
    for (const value of Object.values(result.timings)) expect(value).toBeGreaterThanOrEqual(0);
    expect(result.timings.total).toBeGreaterThanOrEqual(result.timings.import);
    expect(result.peakMemoryBytes).toBeGreaterThan(0);
    expect(result.peakMemoryBytes % 65_536).toBe(0);
    const bytes = result[0].files[0]?.bytes;
    expect(bytes?.byteLength).toBe(bytes?.buffer.byteLength);
  });
});
