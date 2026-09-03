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

const addon = (overrides: Partial<NativeAddon> = {}): NativeAddon => ({
  buildIdentity: `${process.platform}-${process.arch}-napi8`,
  napiVersion: 8,
  packageVersion,
  preparePlan: () => ({}),
  runPlan: async () => 1,
  pendingName: () => undefined,
  supplyPlan: () => undefined,
  takePlanResult: () => ({ ok: true, code: '', message: '', formats: [{ format: 'glb', files: [] }] }),
  destroyPlan: () => undefined,
  ...overrides,
});

const wasmRuntime = (): NativeRuntime => ({
  backend: 'wasm',
  preparePlan: () => 1,
  runPlan: async () => 1,
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
  });

  it('adapts completed work and forwards every plan operation', async () => {
    const handle = {};
    const preparePlan = vi.fn(() => handle);
    const runPlan = vi.fn(async () => 1);
    const takePlanResult = vi.fn(() => ({ ok: true, code: '' as const, message: '', formats: [] }));
    const destroyPlan = vi.fn();
    const runtime = adaptNativeAddon(addon({ preparePlan, runPlan, takePlanResult, destroyPlan }));

    expect(runtime.backend).toBe('native');
    expect(runtime.buildIdentity).toBe(`${process.platform}-${process.arch}-napi8`);
    expect(runtime.preparePlan('cube.obj', [], { importProperties: [], postProcess: 0, targets: [] })).toBe(
      handle,
    );
    await expect(runtime.runPlan(handle, new ResolutionContext(undefined))).resolves.toBe(1);
    expect(runtime.takePlanResult(handle)).toEqual({ ok: true, code: '', message: '', formats: [] });
    runtime.destroyPlan(handle);
    runtime.dispose();
    expect(runPlan).toHaveBeenCalledWith(handle);
    expect(destroyPlan).toHaveBeenCalledWith(handle);
  });

  it('replays found and missing sidecars through the common conversion runner', async () => {
    const handle = {};
    const runPlan = vi.fn().mockResolvedValueOnce(-1).mockResolvedValueOnce(-1).mockResolvedValueOnce(1);
    const pendingName = vi.fn().mockReturnValueOnce('material.mtl').mockReturnValueOnce('missing.png');
    const supplyPlan = vi.fn();
    const runtime = adaptNativeAddon(addon({ preparePlan: () => handle, runPlan, pendingName, supplyPlan }));
    const request = prepareConversion(
      { name: 'cube.obj', bytes: new Uint8Array([1]) },
      {
        targets: [{ to: 'glb' }] as const,
        resolve: (name) => (name === 'material.mtl' ? new Uint8Array([2]) : undefined),
      },
      new Set(['glb']),
    );

    await expect(runPreparedConversion(runtime, request)).resolves.toEqual([{ format: 'glb', files: [] }]);
    expect(supplyPlan).toHaveBeenNthCalledWith(1, handle, 'material.mtl', new Uint8Array([2]));
    expect(supplyPlan).toHaveBeenNthCalledWith(2, handle, 'missing.png', undefined);
  });

  it('keeps resolver rejection causal and rejects pending without a name', async () => {
    const cause = new Error('offline');
    const rejected = adaptNativeAddon(
      addon({
        runPlan: vi.fn().mockResolvedValueOnce(-1),
        pendingName: () => 'sidecar.bin',
      }),
    );
    const request = prepareConversion(
      { name: 'cube.obj', bytes: new Uint8Array([1]) },
      { targets: [{ to: 'glb' }] as const, resolve: async () => Promise.reject(cause) },
      new Set(['glb']),
    );
    await expect(runPreparedConversion(rejected, request)).rejects.toMatchObject({
      code: 'RESOLVE_FAILED',
      cause,
    });

    const unnamed = adaptNativeAddon(addon({ runPlan: async () => -1 }));
    await expect(runPreparedConversion(unnamed, request)).rejects.toThrow(
      'PENDING without new resolver work',
    );
  });

  it('stages asynchronous resolver bytes once and handles invalid results', async () => {
    const supplied = vi.fn();
    const context = new ResolutionContext(async () => new Uint8Array([3]));
    context.stageNative('shared.bin', supplied);
    context.stageNative('shared.bin', supplied);
    await Promise.all(context.takePending());
    expect(supplied).toHaveBeenCalledTimes(2);
    expect(supplied).toHaveBeenNthCalledWith(1, new Uint8Array([3]));
    expect(supplied).toHaveBeenNthCalledWith(2, new Uint8Array([3]));

    const invalid = new ResolutionContext(() => 'bad' as unknown as Uint8Array);
    invalid.stageNative('bad.bin', supplied);
    await Promise.all(invalid.takePending());
    expect(invalid.getFailure()).toMatchObject({ fileName: 'bad.bin' });
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
