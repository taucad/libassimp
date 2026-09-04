import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

import { ResolutionContext, prepareConversion, runPreparedConversion } from './convert.js';
import type { NativeRuntime } from './convert.js';
import {
  adaptNativeAddon,
  createNodeRuntimeLoader,
  loadNativeAddon,
  type NativeAddon,
} from './native-backend.js';

const packageVersion = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
const MISSING = 0;
const FOUND = 1;
const FAILED = 2;
const ABORTED = 3;

const addon = (overrides: Partial<NativeAddon> = {}): NativeAddon => ({
  buildIdentity: `${process.platform}-${process.arch}-napi8`,
  napiVersion: 8,
  packageVersion,
  preparePlan: () => ({}),
  runPlan: async () => 1,
  cancelPlan: () => undefined,
  takePlanResult: () => ({ ok: true, code: '', message: '', formats: [{ format: 'glb', files: [] }] }),
  destroyPlan: () => undefined,
  ...overrides,
});

const wasmRuntime = (): NativeRuntime => ({
  backend: 'wasm',
  preparePlan: () => 1,
  runPlan: async () => 1,
  cancelPlan: () => undefined,
  takePlanResult: () => ({ ok: true, code: '', message: '', formats: [] }),
  destroyPlan: () => undefined,
  dispose: () => undefined,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('native addon adapter', () => {
  it('loads the generated module lazily and rejects incompatible loaders', async () => {
    await expect(loadNativeAddon()).resolves.toMatchObject({ napiVersion: 8 });
    expect(() => adaptNativeAddon(addon({ buildIdentity: 'wrong-target-napi8' }))).toThrow(
      'native build identity mismatch',
    );
    expect(() => adaptNativeAddon(addon({ napiVersion: 9 }))).toThrow('Node-API version mismatch');
    expect(() => adaptNativeAddon(addon({ packageVersion: '0.1.2' }))).toThrow(
      'native package version mismatch',
    );
    expect(() =>
      adaptNativeAddon(addon({ runPlan: undefined as unknown as NativeAddon['runPlan'] })),
    ).toThrow("native loader is missing 'runPlan'");
    expect(() =>
      adaptNativeAddon(addon({ cancelPlan: undefined as unknown as NativeAddon['cancelPlan'] })),
    ).toThrow("native loader is missing 'cancelPlan'");
  });

  it('adapts completed work and forwards every plan operation', async () => {
    const handle = {};
    const preparePlan = vi.fn(() => handle);
    const runPlan = vi.fn(async () => 1);
    const cancelPlan = vi.fn();
    const takePlanResult = vi.fn(() => ({ ok: true, code: '' as const, message: '', formats: [] }));
    const destroyPlan = vi.fn();
    const runtime = adaptNativeAddon(
      addon({ preparePlan, runPlan, cancelPlan, takePlanResult, destroyPlan }),
    );

    expect(runtime.backend).toBe('native');
    expect(runtime.buildIdentity).toBe(`${process.platform}-${process.arch}-napi8`);
    expect(runtime.preparePlan('cube.obj', [], { importProperties: [], postProcess: 0, targets: [] })).toBe(
      handle,
    );
    await expect(runtime.runPlan(handle, new ResolutionContext(undefined))).resolves.toBe(1);
    expect(runtime.takePlanResult(handle)).toEqual({ ok: true, code: '', message: '', formats: [] });
    runtime.destroyPlan(handle);
    runtime.cancelPlan(handle);
    runtime.dispose();
    expect(runPlan).toHaveBeenCalledWith(handle, expect.any(Function));
    expect(cancelPlan).toHaveBeenCalledWith(handle);
    expect(destroyPlan).toHaveBeenCalledWith(handle);
  });

  it('settles found and missing sidecars through one native run', async () => {
    const handle = {};
    const settlements: unknown[][] = [];
    let requestLate: Parameters<NativeAddon['runPlan']>[1] | undefined;
    const runPlan: NativeAddon['runPlan'] = vi.fn(
      async (_plan: unknown, resolveRequest: Parameters<NativeAddon['runPlan']>[1]) => {
        requestLate = resolveRequest;
        for (const name of ['material.mtl', 'missing.png']) {
          await new Promise<void>((resolve) => {
            resolveRequest(name, (status: 0 | 1 | 2 | 3, bytes?: Uint8Array) => {
              settlements.push(bytes === undefined ? [status] : [status, bytes]);
              resolve();
            });
          });
        }
        return 1;
      },
    );
    const runtime = adaptNativeAddon(addon({ preparePlan: () => handle, runPlan }));
    const request = prepareConversion(
      { name: 'cube.obj', bytes: new Uint8Array([1]) },
      {
        targets: [{ to: 'glb' }] as const,
        resolve: (name) => (name === 'material.mtl' ? new Uint8Array([2]) : undefined),
      },
      new Set(['glb']),
    );

    await expect(runPreparedConversion(runtime, request)).resolves.toEqual([{ format: 'glb', files: [] }]);
    expect(runPlan).toHaveBeenCalledOnce();
    expect(settlements).toEqual([[FOUND, new Uint8Array([2])], [MISSING]]);
    const late = vi.fn();
    requestLate?.('late.bin', late);
    await Promise.resolve();
    expect(late).not.toHaveBeenCalled();
  });

  it.each([
    ['rejection', async () => Promise.reject(new Error('offline'))],
    ['invalid result', () => 'bad' as unknown as Uint8Array],
    ['typed-array proxy', () => new Proxy(new Uint8Array([1]), {})],
    ['promised typed-array proxy', async () => new Proxy(new Uint8Array([1]), {})],
  ] as const)('settles a resolver %s as failed with causal context', async (_label, resolve) => {
    const cause = new Error('offline');
    const settlements: unknown[][] = [];
    const runPlan: NativeAddon['runPlan'] = vi.fn(
      (_plan: unknown, resolveRequest: Parameters<NativeAddon['runPlan']>[1]) =>
        new Promise<number>((finish) => {
          resolveRequest('sidecar.bin', (status: 0 | 1 | 2 | 3, bytes?: Uint8Array) => {
            settlements.push(bytes === undefined ? [status] : [status, bytes]);
            finish(2);
          });
        }),
    );
    const rejected = adaptNativeAddon(addon({ runPlan }));
    const request = prepareConversion(
      { name: 'cube.obj', bytes: new Uint8Array([1]) },
      {
        targets: [{ to: 'glb' }] as const,
        resolve: _label === 'rejection' ? async () => Promise.reject(cause) : resolve,
      },
      new Set(['glb']),
    );
    await expect(runPreparedConversion(rejected, request)).rejects.toMatchObject({
      code: 'RESOLVE_FAILED',
      fileName: 'sidecar.bin',
      ...(_label === 'rejection' ? { cause } : {}),
    });
    expect(settlements).toEqual([[FAILED]]);
    expect(runPlan).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    'releases copied native sidecar state before plan completion (async: %s)',
    async (asynchronous) => {
      const bytes = new Uint8Array([3, 4]);
      const context = new ResolutionContext(() => (asynchronous ? Promise.resolve(bytes) : bytes));
      const runPlan: NativeAddon['runPlan'] = (_plan, resolveRequest) =>
        new Promise((finish) => {
          resolveRequest('copied.bin', (status, copied) => {
            expect(status).toBe(FOUND);
            expect(copied).toBe(bytes);
            expect(Reflect.get(context, 'states')).toHaveProperty('size', 1);
            finish(1);
          });
        });
      await adaptNativeAddon(addon({ runPlan })).runPlan({}, context);
      expect(Reflect.get(context, 'states')).toEqual(new Map());
      context.dispose();
    },
  );

  it('settles abort, cancels native work, and ignores late resolver completion', async () => {
    const controller = new AbortController();
    const reason = { phase: 'native-resolve' };
    const settlements: unknown[][] = [];
    let release: ((bytes: Uint8Array) => void) | undefined;
    const handle = {};
    const runPlan: NativeAddon['runPlan'] = vi.fn(
      (_plan: unknown, resolveRequest: Parameters<NativeAddon['runPlan']>[1]) =>
        new Promise<number>((finish) => {
          resolveRequest('slow.bin', (status: 0 | 1 | 2 | 3, bytes?: Uint8Array) => {
            settlements.push(bytes === undefined ? [status] : [status, bytes]);
            finish(2);
          });
        }),
    );
    const cancelPlan = vi.fn();
    const destroyPlan = vi.fn();
    const runtime = adaptNativeAddon(addon({ preparePlan: () => handle, runPlan, cancelPlan, destroyPlan }));
    const request = prepareConversion(
      { name: 'cube.obj', bytes: new Uint8Array([1]) },
      {
        targets: [{ to: 'glb' }] as const,
        resolve: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
        signal: controller.signal,
      },
      new Set(['glb']),
    );

    const conversion = runPreparedConversion(runtime, request);
    await vi.waitFor(() => {
      expect(runPlan).toHaveBeenCalledOnce();
    });
    controller.abort(reason);
    await expect(conversion).rejects.toBe(reason);
    expect(settlements).toEqual([[ABORTED]]);
    expect(cancelPlan).toHaveBeenCalledOnce();
    expect(cancelPlan).toHaveBeenCalledWith(handle);
    expect(destroyPlan).toHaveBeenCalledOnce();
    release?.(new Uint8Array([3]));
    await Promise.resolve();
    expect(settlements).toEqual([[ABORTED]]);
  });
});

describe('Node backend selection', () => {
  it('does not touch native loading when Wasm is forced', async () => {
    const runtime = wasmRuntime();
    const loadWasm = vi.fn(async () => runtime);
    const loadNative = vi.fn(async () => addon());
    await expect(createNodeRuntimeLoader(loadWasm, loadNative)({ backend: 'wasm' })).resolves.toBe(runtime);
    expect(loadNative).not.toHaveBeenCalled();
  });

  it('loads native for auto and forced-native requests', async () => {
    const loadNative = vi.fn(async () => addon());
    const loader = createNodeRuntimeLoader(async () => wasmRuntime(), loadNative);
    await expect(loader({})).resolves.toMatchObject({ backend: 'native' });
    await expect(loader({ backend: 'native' })).resolves.toMatchObject({ backend: 'native' });
    expect(loadNative).toHaveBeenCalledTimes(2);
  });

  it('throws a typed causal error when native is forced', async () => {
    const cause = new Error('optional package missing');
    const loader = createNodeRuntimeLoader(
      async () => wasmRuntime(),
      async () => Promise.reject(cause),
    );
    await expect(loader({ backend: 'native' })).rejects.toMatchObject({
      code: 'IMPORT_FAILED',
      cause,
    });
  });

  it('warns once with the cause before automatic Wasm fallback', async () => {
    const cause = new Error('corrupt addon');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const runtime = wasmRuntime();
    const loader = createNodeRuntimeLoader(
      async () => runtime,
      async () => Promise.reject(cause),
    );
    await expect(loader({ backend: 'auto' })).resolves.toBe(runtime);
    expect(warning).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('reinstall libassimp'), cause);
  });

  it('reports the same causal warning through onLog when supplied', async () => {
    const cause = new Error('unsupported host');
    const onLog = vi.fn();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const loader = createNodeRuntimeLoader(
      async () => wasmRuntime(),
      async () => Promise.reject(cause),
    );
    await loader({ onLog });
    expect(onLog).toHaveBeenCalledWith({
      level: 'warning',
      message: expect.stringContaining(`${process.platform}-${process.arch}`),
      cause,
    });
    expect(warning).not.toHaveBeenCalled();
  });
});
