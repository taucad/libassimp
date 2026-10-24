import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ResolutionContext, type NativeRuntime } from './convert.js';
import {
  compileCached,
  compileUrl,
  createEntry,
  isJspiAvailable,
  loadModule,
  missingImport,
  type CreateAssimpOptions,
} from './create-assimp.js';
import { assimpCapabilities } from './generated/assimp-capabilities.js';
import { createAssimp } from './index.js';

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`../tests/fixtures/${name}`, import.meta.url)));
const model = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`../assimp/test/models/${name}`, import.meta.url)));
const cube = fixture('cube.obj');
const wasmPath = new URL('./wasm/libassimp.wasm', import.meta.url);
const testWasm = Uint8Array.from([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 13, 2, 96, 3, 127, 127, 127, 1, 127, 96, 1, 127, 1, 127, 2, 12, 1, 3, 101,
  110, 118, 4, 104, 111, 115, 116, 0, 0, 3, 2, 1, 1, 5, 3, 1, 0, 1, 7, 16, 2, 6, 109, 101, 109, 111, 114, 121,
  2, 0, 3, 114, 117, 110, 0, 1, 10, 6, 1, 4, 0, 32, 0, 11,
]);
const testWasmWithoutMemory = Uint8Array.from([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 13, 2, 96, 3, 127, 127, 127, 1, 127, 96, 1, 127, 1, 127, 2, 12, 1, 3, 101,
  110, 118, 4, 104, 111, 115, 116, 0, 0, 3, 2, 1, 1, 7, 7, 1, 3, 114, 117, 110, 0, 1, 10, 6, 1, 4, 0, 32, 0,
  11,
]);

const glueUrl = (
  options: {
    readonly instantiate?: boolean;
    readonly raw?: boolean;
    readonly callHost?: boolean;
    readonly successfulPlan?: boolean;
  } = {},
) => {
  const source = `export default async options => {
    options.locateFile();
    options.print('fake info');
    options.printErr('fake error');
    const imports = { env: {} };
    let instance;
    ${
      options.instantiate === false
        ? ''
        : `const received = new Promise(resolve => {
      options.instantiateWasm(imports, value => { instance = value; resolve(); });
    });
    await received;`
    }
    ${options.callHost === true ? `imports.env.host(1, 0, 0);` : ''}
    return {
      _libassimp_run_plan: ${options.raw === false ? 'undefined' : 'instance?.exports.run'},
      preparePlan: () => 1,
      takePlanResult: () => ({ ok: true, code: '', message: '', formats: ${
        options.successfulPlan === true ? "[{ format: 'glb', files: [] }]" : '[]'
      } }),
      destroyPlan: () => undefined,
    };
  };`;
  return new URL(`data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`);
};

const jspiDescriptors = {
  promising: Object.getOwnPropertyDescriptor(WebAssembly, 'promising'),
  Suspending: Object.getOwnPropertyDescriptor(WebAssembly, 'Suspending'),
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const [name, descriptor] of Object.entries(jspiDescriptors)) {
    if (descriptor === undefined) Reflect.deleteProperty(WebAssembly, name);
    else Object.defineProperty(WebAssembly, name, descriptor);
  }
});

describe('loader boundaries', () => {
  it('compiles fetched Wasm through streaming and byte fallback and reports HTTP errors', async () => {
    const compiled = new WebAssembly.Module(testWasm);
    const response = (): Response => new Response(testWasm.slice().buffer);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 503, statusText: 'Offline' }))
        .mockResolvedValueOnce(response())
        .mockResolvedValueOnce(response()),
    );
    vi.spyOn(WebAssembly, 'compileStreaming')
      .mockResolvedValueOnce(compiled)
      .mockRejectedValueOnce(new TypeError('stream unavailable'));

    await expect(compileUrl(new URL('https://example.test/missing.wasm'))).rejects.toThrow('503 Offline');
    await expect(compileUrl(new URL('https://example.test/stream.wasm'))).resolves.toBe(compiled);
    await expect(compileUrl(new URL('https://example.test/bytes.wasm'))).resolves.toBeInstanceOf(
      WebAssembly.Module,
    );
  });

  it('requires exactly one missing function import', () => {
    const compiled = new WebAssembly.Module(testWasm);
    expect(missingImport(compiled, { env: {} })).toMatchObject({
      kind: 'function',
      module: 'env',
      name: 'host',
    });
    expect(() => missingImport(compiled, { env: { host: () => 0 } })).toThrow('found 0');
    vi.spyOn(WebAssembly.Module, 'imports').mockReturnValue([
      { kind: 'memory', module: 'env', name: 'memory' },
    ]);
    expect(() => missingImport(compiled, {})).toThrow('found 1');
  });

  it('detects only complete JSPI support', () => {
    Object.defineProperty(WebAssembly, 'Suspending', { configurable: true, value: undefined });
    Object.defineProperty(WebAssembly, 'promising', { configurable: true, value: undefined });
    expect(isJspiAvailable()).toBe(false);
    Object.defineProperty(WebAssembly, 'Suspending', { configurable: true, value: function () {} });
    expect(isJspiAvailable()).toBe(false);
    Object.defineProperty(WebAssembly, 'promising', { configurable: true, value: () => undefined });
    expect(isJspiAvailable()).toBe(true);
  });

  it('binds the test artifact, logs glue output, and rejects re-entry', async () => {
    const logs: string[] = [];
    const runtime = await loadModule(glueUrl(), new URL('https://example.test/default.wasm'), {
      wasmBinary: testWasm,
      onLog: ({ level, message }) => logs.push(`${level}:${message}`),
    });
    expect(logs).toEqual(['info:fake info', 'error:fake error']);
    const first = runtime.runPlan(7, new ResolutionContext(undefined));
    await expect(runtime.runPlan(8, new ResolutionContext(undefined))).rejects.toThrow('re-entry');
    await expect(first).resolves.toBe(7);
  });

  it('wraps the same artifact with JSPI when the host exposes it', async () => {
    Object.defineProperty(WebAssembly, 'Suspending', {
      configurable: true,
      value: function (callback: (...arguments_: number[]) => number | Promise<number>) {
        return callback;
      },
    });
    Object.defineProperty(WebAssembly, 'promising', {
      configurable: true,
      value: (callback: (handle: number) => number) => async (handle: number) => callback(handle),
    });
    const runtime = await loadModule(glueUrl(), new URL('https://example.test/default.wasm'), {
      wasmBinary: testWasm,
    });
    await expect(runtime.runPlan(9, new ResolutionContext(undefined))).resolves.toBe(9);
  });

  it.each([
    {
      label: 'missing raw export',
      wasmBinary: testWasm,
      url: glueUrl({ raw: false }),
      message: 'missing its memory or stable raw plan export',
    },
    {
      label: 'missing memory',
      wasmBinary: testWasmWithoutMemory,
      url: glueUrl(),
      message: 'missing its memory or stable raw plan export',
    },
    {
      label: 'host dispatch outside conversion',
      wasmBinary: testWasm,
      url: glueUrl({ callHost: true }),
      message: 'outside an active conversion',
    },
    {
      label: 'glue omits instantiation',
      wasmBinary: testWasm,
      url: glueUrl({ instantiate: false }),
      message: 'did not request Wasm instantiation',
    },
  ] as const)('rejects an artifact with $label', async ({ label, wasmBinary, url, message }) => {
    if (label === 'host dispatch outside conversion') {
      Object.defineProperty(WebAssembly, 'Suspending', { configurable: true, value: undefined });
      Object.defineProperty(WebAssembly, 'promising', { configurable: true, value: undefined });
    }
    await expect(
      loadModule(url, new URL('https://example.test/default.wasm'), { wasmBinary }),
    ).rejects.toThrow(message);
  });

  it('logs a non-Error loader rejection without changing it', async () => {
    const messages: string[] = [];
    const options = {
      get wasmBinary(): Uint8Array {
        throw 'string failure';
      },
      onLog: ({ message }: { readonly message: string }) => messages.push(message),
    };
    await expect(loadModule(glueUrl(), new URL('https://example.test/default.wasm'), options)).rejects.toBe(
      'string failure',
    );
    expect(messages).toEqual(['string failure']);
  });
});

describe('createAssimp loading and lifetime', () => {
  it('exposes generated canonical directional format tables', async () => {
    using assimp = await createAssimp();
    expect(assimp.backend).toBe('wasm');
    expect(assimp.formats.export.map(({ id }) => id)).toEqual([
      '3mf',
      'assjson',
      'dae',
      'fbx',
      'glb',
      'gltf',
      'obj',
      'ply',
      'step',
      'stl',
      'usda',
      'usdc',
      'usdz',
    ]);
    expect(assimp.formats.import.map(({ id }) => id)).toContain('obj');
    expect(assimp.formats.export.find(({ id }) => id === 'stl')?.exportOptions).toHaveProperty('binary');
  });

  it('rejects forced native loading from the browser-safe entry', async () => {
    await expect(createAssimp({ backend: 'native' })).rejects.toMatchObject({
      code: 'BACKEND_UNAVAILABLE',
      message: expect.stringContaining(
        'backend: native is unavailable from the browser-safe libassimp entry',
      ),
    });
  });

  it('rejects an invalid runtime preference before loading', async () => {
    await expect(createAssimp({ backend: 'gpu' as 'wasm' })).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    });
  });

  it.each([
    ['a URL', wasmPath],
    ['a string', wasmPath.href],
  ])('loads the one artifact from wasmUrl given as %s', async (_label, wasmUrl) => {
    using assimp = await createAssimp({ wasmUrl });
    expect((await assimp.convert({ name: 'cube.obj', bytes: cube }, { to: 'glb' })).files[0]?.name).toBe(
      'cube.glb',
    );
  });

  it('instantiates the same artifact from wasmBinary', async () => {
    using assimp = await createAssimp({ wasmBinary: new Uint8Array(readFileSync(wasmPath)) });
    expect((await assimp.convert({ name: 'cube.obj', bytes: cube }, { to: 'glb' })).files[0]?.name).toBe(
      'cube.glb',
    );
  });

  it('reports loader failures through onLog', async () => {
    const entries: string[] = [];
    const missing = new URL('./wasm/libassimp-absent.wasm', import.meta.url);
    await expect(
      createAssimp({ wasmUrl: missing, onLog: ({ message }) => entries.push(message) }),
    ).rejects.toThrow();
    expect(entries.join('\n')).toContain('libassimp-absent.wasm');
  });

  it('preserves exact abort reasons before work and while resolving', async () => {
    using assimp = await createAssimp();
    const before = new AbortController();
    const beforeReason = { phase: 'before-work' };
    const resolve = vi.fn(() => undefined);
    before.abort(beforeReason);
    await expect(
      assimp.convert(
        { name: 'cube_usemtl.obj', bytes: model('OBJ/cube_usemtl.obj') },
        { to: 'glb', resolve, signal: before.signal },
      ),
    ).rejects.toBe(beforeReason);
    expect(resolve).not.toHaveBeenCalled();
    await expect(
      assimp.convertFormats(
        { name: 'cube.obj', bytes: cube },
        { targets: [{ to: 'glb' }], signal: before.signal },
      ),
    ).rejects.toBe(beforeReason);

    const during = new AbortController();
    const duringReason = { phase: 'while-resolving' };
    let started: (() => void) | undefined;
    const resolving = new Promise<void>((resolveStarted) => {
      started = resolveStarted;
    });
    let settle: ((bytes: Uint8Array) => void) | undefined;
    const conversion = assimp.convert(
      { name: 'cube_usemtl.obj', bytes: model('OBJ/cube_usemtl.obj') },
      {
        to: 'glb',
        signal: during.signal,
        resolve: () => {
          started?.();
          return new Promise((resolveBytes) => {
            settle = resolveBytes;
          });
        },
      },
    );
    await resolving;
    during.abort(duringReason);
    await expect(conversion).rejects.toBe(duringReason);
    settle?.(model('OBJ/cube_usemtl.mtl'));
    await Promise.resolve();
  });

  it('cancels queued Wasm admission without waiting for its predecessor', async () => {
    const preparePlan = vi.fn(() => 1);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime: NativeRuntime = {
      backend: 'wasm',
      preparePlan,
      runPlan: vi.fn(async () => {
        await gate;
        return 1;
      }),
      cancelPlan: vi.fn(),
      takePlanResult: () => ({
        ok: true,
        code: '',
        message: '',
        formats: [{ format: 'glb', files: [] }],
      }),
      destroyPlan: vi.fn(),
      dispose: vi.fn(),
      peakMemoryBytes: () => 0,
    };
    const entry = createEntry(glueUrl(), new URL('https://example.test/queued.wasm'), {
      import: [assimpCapabilities.import.obj],
      export: [assimpCapabilities.export.glb],
      loadRuntime: async () => runtime,
    });
    using assimp = await entry.createAssimp();
    const first = assimp.convert({ name: 'cube.obj', bytes: cube }, { to: 'glb' });
    await vi.waitFor(() => {
      expect(preparePlan).toHaveBeenCalledOnce();
    });
    const controller = new AbortController();
    const reason = { phase: 'queued' };
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const second = assimp.convert(
      { name: 'cube.obj', bytes: cube },
      { to: 'glb', signal: controller.signal },
    );
    const rejected = vi.fn();
    void second.catch(rejected);
    controller.abort(reason);
    await new Promise<void>(setImmediate);
    expect(rejected).toHaveBeenCalledWith(reason);
    const listener = add.mock.calls.find(([type]) => type === 'abort')?.[1];
    expect(listener).toEqual(expect.any(Function));
    expect(remove).toHaveBeenCalledWith('abort', listener);
    expect(preparePlan).toHaveBeenCalledOnce();

    const third = assimp.convert({ name: 'cube.obj', bytes: cube }, { to: 'glb' });
    await Promise.resolve();
    expect(preparePlan).toHaveBeenCalledOnce();
    release?.();
    await expect(first).resolves.toBeDefined();
    await expect(second).rejects.toBe(reason);
    await expect(third).resolves.toBeDefined();
    expect(preparePlan).toHaveBeenCalledTimes(2);
  });

  it('lets the native executor own admission while disposal only tracks the drain', async () => {
    let nextHandle = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime: NativeRuntime = {
      backend: 'native',
      preparePlan: vi.fn(() => (nextHandle += 1)),
      runPlan: vi.fn(async (handle) => {
        if (handle === 1) await gate;
        return 1;
      }),
      cancelPlan: vi.fn(),
      takePlanResult: () => ({
        ok: true,
        code: '',
        message: '',
        formats: [{ format: 'glb', files: [] }],
      }),
      destroyPlan: vi.fn(),
      dispose: vi.fn(),
      peakMemoryBytes: () => 0,
    };
    const entry = createEntry(glueUrl(), new URL('https://example.test/native.wasm'), {
      import: [assimpCapabilities.import.obj],
      export: [assimpCapabilities.export.glb],
      loadRuntime: async () => runtime,
    });
    const assimp = await entry.createAssimp();
    const first = assimp.convert({ name: 'cube.obj', bytes: cube }, { to: 'glb' });
    const second = assimp.convert({ name: 'cube.obj', bytes: cube }, { to: 'glb' });
    const secondSettled = vi.fn();
    void second.then(secondSettled);
    await new Promise<void>(setImmediate);
    expect(secondSettled).toHaveBeenCalledWith(expect.objectContaining({ files: [] }));
    expect(runtime.preparePlan).toHaveBeenCalledTimes(2);

    const disposed = assimp.dispose();
    expect(assimp.dispose()).toBe(disposed);
    await new Promise<void>(setImmediate);
    expect(runtime.dispose).not.toHaveBeenCalled();
    release?.();
    await expect(first).resolves.toMatchObject({ files: [] });
    await expect(disposed).resolves.toBeUndefined();
    expect(runtime.dispose).toHaveBeenCalledOnce();
  });

  it('serializes suspended work, recovers after rejection, and settles queued work on dispose', async () => {
    const assimp = await createAssimp();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = assimp.convert(
      { name: 'cube_usemtl.obj', bytes: model('OBJ/cube_usemtl.obj') },
      {
        to: 'glb',
        resolve: async (name) => {
          await gate;
          return name.endsWith('.mtl') ? model('OBJ/cube_usemtl.mtl') : undefined;
        },
      },
    );
    let secondSettled = false;
    const second = assimp.convert({ name: 'cube.obj', bytes: cube }, { to: 'stl' }).then((result) => {
      secondSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    const disposed = assimp.dispose();
    await expect(assimp.convert({ name: 'cube.obj', bytes: cube }, { to: 'glb' })).rejects.toThrow(
      'assimp instance disposed',
    );
    release?.();
    expect((await first).files[0]?.name).toBe('cube_usemtl.glb');
    expect((await second).files[0]?.name).toBe('cube.stl');
    await disposed;
  });

  it('advances the queue after a resolver rejection', async () => {
    using assimp = await createAssimp();
    const failed = assimp.convert(
      { name: 'cube_usemtl.obj', bytes: model('OBJ/cube_usemtl.obj') },
      { to: 'glb', resolve: async () => Promise.reject(new Error('offline')) },
    );
    const next = assimp.convert({ name: 'cube.obj', bytes: cube }, { to: 'glb' });
    await expect(failed).rejects.toMatchObject({ code: 'RESOLVE_FAILED' });
    await expect(next).resolves.toMatchObject({ files: [{ name: 'cube.glb' }] });
  });

  it('allows separate instances to progress independently', async () => {
    using first = await createAssimp();
    using second = await createAssimp();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const suspended = first.convert(
      { name: 'cube_usemtl.obj', bytes: model('OBJ/cube_usemtl.obj') },
      {
        to: 'glb',
        resolve: async () => {
          await gate;
          return undefined;
        },
      },
    );
    await expect(second.convert({ name: 'cube.obj', bytes: cube }, { to: 'glb' })).resolves.toBeDefined();
    release?.();
    await expect(suspended).resolves.toBeDefined();
  });

  it('registers no process listeners', async () => {
    const before = ['unhandledRejection', 'uncaughtException'].map((event) => process.listenerCount(event));
    const instances = await Promise.all(Array.from({ length: 3 }, () => createAssimp()));
    await Promise.all(instances.map(async (assimp) => assimp.dispose()));
    expect(['unhandledRejection', 'uncaughtException'].map((event) => process.listenerCount(event))).toEqual(
      before,
    );
  });

  it('passes every singular option and makes repeated disposal inert', async () => {
    const assimp = await createAssimp();
    await expect(
      assimp.convert(
        { name: 'cube.obj', bytes: cube },
        {
          to: 'obj',
          resolve: () => undefined,
          importOptions: { favourSpeed: true },
          postProcess: ['triangulate'],
          exportOptions: { materials: false },
        },
      ),
    ).resolves.toMatchObject({ files: [{ name: 'cube.obj' }] });
    await assimp.dispose();
    await assimp.dispose();
  });

  it('normalizes a non-Error validation throw', async () => {
    using assimp = await createAssimp();
    const options = Object.defineProperty({}, 'targets', {
      get: () => {
        throw 'invalid getter';
      },
    }) as { readonly targets: readonly [{ readonly to: 'glb' }] };
    await expect(assimp.convertFormats({ name: 'cube.obj', bytes: cube }, options)).rejects.toThrow(
      'invalid getter',
    );
  });
});

describe('shared entry loader', () => {
  it.each(['convert', 'convertFormats'] as const)(
    'cancels top-level %s before and during shared initialization',
    async (method) => {
      let finishLoad: ((runtime: NativeRuntime) => void) | undefined;
      const preparePlan = vi.fn(() => 1);
      const runtime: NativeRuntime = {
        backend: 'wasm',
        preparePlan,
        runPlan: vi.fn(async () => 1),
        cancelPlan: vi.fn(),
        takePlanResult: () => ({
          ok: true,
          code: '',
          message: '',
          formats: [{ format: 'glb', files: [] }],
        }),
        destroyPlan: vi.fn(),
        dispose: vi.fn(),
        peakMemoryBytes: () => 0,
      };
      const loadRuntime = vi.fn(
        () =>
          new Promise<NativeRuntime>((resolve) => {
            finishLoad = resolve;
          }),
      );
      const entry = createEntry(glueUrl(), new URL('https://example.test/pending.wasm'), {
        import: [assimpCapabilities.import.obj],
        export: [assimpCapabilities.export.glb],
        loadRuntime,
      });
      const call = (signal: AbortSignal) =>
        method === 'convert'
          ? entry.convert({ name: 'cube.obj', bytes: cube }, { to: 'glb', signal })
          : entry.convertFormats({ name: 'cube.obj', bytes: cube }, { targets: [{ to: 'glb' }], signal });

      const before = new AbortController();
      const beforeReason = { method, phase: 'before-initialization' };
      const beforeRejected = vi.fn();
      before.abort(beforeReason);
      void call(before.signal).catch(beforeRejected);
      await new Promise<void>(setImmediate);
      expect(beforeRejected).toHaveBeenCalledWith(beforeReason);
      expect(loadRuntime).not.toHaveBeenCalled();

      const during = new AbortController();
      const duringReason = { method, phase: 'during-initialization' };
      const add = vi.spyOn(during.signal, 'addEventListener');
      const remove = vi.spyOn(during.signal, 'removeEventListener');
      const pending = call(during.signal);
      const duringRejected = vi.fn();
      void pending.catch(duringRejected);
      expect(loadRuntime).toHaveBeenCalledOnce();
      during.abort(duringReason);
      await new Promise<void>(setImmediate);
      expect(duringRejected).toHaveBeenCalledWith(duringReason);
      const listener = add.mock.calls.find(([type]) => type === 'abort')?.[1];
      expect(listener).toEqual(expect.any(Function));
      expect(remove).toHaveBeenCalledWith('abort', listener);

      finishLoad?.(runtime);
      await new Promise<void>(setImmediate);
      expect(preparePlan).not.toHaveBeenCalled();
    },
  );

  it('recycles the idle shared instance once a job grows its memory past 512 MiB', async () => {
    let memoryBytes = 600 * 1024 * 1024;
    const dispose = vi.fn();
    const loadRuntime = vi.fn(
      async (): Promise<NativeRuntime> => ({
        backend: 'wasm',
        preparePlan: () => 1,
        runPlan: async () => 1,
        cancelPlan: vi.fn(),
        takePlanResult: () => ({
          ok: true,
          code: '',
          message: '',
          formats: [{ format: 'glb', files: [] }],
        }),
        destroyPlan: vi.fn(),
        dispose,
        memoryBytes: () => memoryBytes,
        peakMemoryBytes: () => memoryBytes,
      }),
    );
    const entry = createEntry(glueUrl(), new URL('https://example.test/recycle.wasm'), {
      import: [assimpCapabilities.import.obj],
      export: [assimpCapabilities.export.glb],
      loadRuntime,
    });

    await entry.convert({ name: 'cube.obj', bytes: cube }, { to: 'glb' });
    await new Promise<void>(setImmediate);
    expect(dispose).toHaveBeenCalledOnce();
    memoryBytes = 64 * 1024 * 1024;
    await entry.convert({ name: 'cube.obj', bytes: cube }, { to: 'glb' });
    await entry.convert({ name: 'cube.obj', bytes: cube }, { to: 'glb' });
    await new Promise<void>(setImmediate);
    expect(loadRuntime).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('retries a failed shared load and reuses the successful instance', async () => {
    const response = (): Response =>
      new Response(testWasm.slice().buffer, { headers: { 'Content-Type': 'application/wasm' } });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503, statusText: 'Offline' }))
      .mockResolvedValueOnce(response());
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(WebAssembly, 'compileStreaming').mockResolvedValue(new WebAssembly.Module(testWasm));
    const entry = createEntry(
      glueUrl({ successfulPlan: true }),
      new URL('https://example.test/shared.wasm'),
      {
        import: [assimpCapabilities.import.obj],
        export: [assimpCapabilities.export.glb],
      },
    );

    const loading = new AbortController();
    const remove = vi.spyOn(loading.signal, 'removeEventListener');
    await expect(
      entry.convert({ name: 'cube.obj', bytes: cube }, { to: 'glb', signal: loading.signal }),
    ).rejects.toThrow('503 Offline');
    expect(remove).toHaveBeenCalledOnce();
    await expect(entry.convert({ name: 'cube.obj', bytes: cube }, { to: 'glb' })).resolves.toMatchObject({
      files: [],
    });
    await expect(entry.convert({ name: 'cube.obj', bytes: cube }, { to: 'glb' })).resolves.toMatchObject({
      files: [],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('runtime replacement, recycling, and disposal', () => {
  const fake = (overrides: Partial<NativeRuntime> = {}): NativeRuntime => ({
    backend: 'wasm',
    preparePlan: () => 1,
    runPlan: async () => 1,
    cancelPlan: vi.fn(),
    takePlanResult: () => ({ ok: true, code: '', message: '', formats: [{ format: 'glb', files: [] }] }),
    destroyPlan: vi.fn(),
    dispose: vi.fn(),
    peakMemoryBytes: () => 0,
    ...overrides,
  });
  const entryWith = (loadRuntime: (options: CreateAssimpOptions) => Promise<NativeRuntime>) =>
    createEntry(glueUrl(), new URL('https://example.test/replace.wasm'), {
      import: [assimpCapabilities.import.obj],
      export: [assimpCapabilities.export.glb],
      loadRuntime,
    });
  const input = { name: 'cube.obj', bytes: cube };

  it.each([-1, Number.NaN, '1'])('rejects recycleAboveBytes %s before loading', async (recycleAboveBytes) => {
    const loadRuntime = vi.fn(async () => fake());
    await expect(
      entryWith(loadRuntime).createAssimp({ recycleAboveBytes: recycleAboveBytes as number }),
    ).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
      message: expect.stringContaining('recycleAboveBytes'),
    });
    expect(loadRuntime).not.toHaveBeenCalled();
  });

  it('replaces a trapped Wasm runtime on the next conversion and keeps the backend', async () => {
    const trap = new WebAssembly.RuntimeError('unreachable');
    const first = fake({ runPlan: async () => Promise.reject(trap) });
    const second = fake();
    const loadRuntime = vi.fn<(options: CreateAssimpOptions) => Promise<NativeRuntime>>();
    loadRuntime.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    await using assimp = await entryWith(loadRuntime).createAssimp({ backend: 'auto' });
    await expect(assimp.convert(input, { to: 'glb' })).rejects.toMatchObject({
      code: 'ENGINE_FAILED',
      cause: trap,
    });
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(first.destroyPlan).not.toHaveBeenCalled();
    await expect(assimp.convert(input, { to: 'glb' })).resolves.toMatchObject({ files: [] });
    expect(loadRuntime).toHaveBeenLastCalledWith({ backend: 'wasm' });
    expect(second.dispose).not.toHaveBeenCalled();
  });

  it('keeps a native runtime after an engine failure and never recycles one without memory figures', async () => {
    const runtime = fake({ backend: 'native', runPlan: async () => Promise.reject(new Error('napi')) });
    const assimp = await entryWith(async () => runtime).createAssimp({ recycleAboveBytes: 0 });
    await expect(assimp.convert(input, { to: 'glb' })).rejects.toMatchObject({ code: 'ENGINE_FAILED' });
    expect(runtime.dispose).not.toHaveBeenCalled();
    await assimp.dispose();
    expect(runtime.dispose).toHaveBeenCalledOnce();
  });

  it('recycles an idle instance above its threshold, never while another job runs, and not at Infinity', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let prepared = 0;
    const runtimes: NativeRuntime[] = [];
    const loadRuntime = vi.fn(async () => {
      const runtime = fake({
        backend: 'native',
        preparePlan: () => (prepared++ === 0 ? 'slow' : 'fast'),
        runPlan: async (handle) => {
          if (handle === 'slow') await gate;
          return 1;
        },
        memoryBytes: () => 2048,
      });
      runtimes.push(runtime);
      return runtime;
    });
    const assimp = await entryWith(loadRuntime).createAssimp({ recycleAboveBytes: 1024 });
    const slow = assimp.convert(input, { to: 'glb' });
    await assimp.convert(input, { to: 'glb' });
    expect(runtimes[0]?.dispose).not.toHaveBeenCalled();
    release?.();
    await slow;
    expect(runtimes[0]?.dispose).toHaveBeenCalledOnce();
    await Promise.all([assimp.convert(input, { to: 'glb' }), assimp.convert(input, { to: 'glb' })]);
    expect(loadRuntime).toHaveBeenCalledTimes(2);
    await assimp.dispose();

    const keep = fake({ memoryBytes: () => 8 * 1024 * 1024 * 1024 });
    await using kept = await entryWith(async () => keep).createAssimp({
      recycleAboveBytes: Number.POSITIVE_INFINITY,
    });
    await kept.convert(input, { to: 'glb' });
    expect(keep.dispose).not.toHaveBeenCalled();
  });

  it('retries a failed reload on the next conversion', async () => {
    const loadRuntime = vi.fn<() => Promise<NativeRuntime>>();
    const failedReload = new Error('instantiate failed');
    loadRuntime
      .mockResolvedValueOnce(fake({ runPlan: async () => Promise.reject(new Error('trap')) }))
      .mockRejectedValueOnce(failedReload)
      .mockResolvedValueOnce(fake());
    await using assimp = await entryWith(loadRuntime).createAssimp();
    await expect(assimp.convert(input, { to: 'glb' })).rejects.toMatchObject({ code: 'ENGINE_FAILED' });
    await expect(assimp.convert(input, { to: 'glb' })).rejects.toBe(failedReload);
    await expect(assimp.convert(input, { to: 'glb' })).resolves.toMatchObject({ files: [] });
    expect(loadRuntime).toHaveBeenCalledTimes(3);
  });

  it('settles disposal after the drain, including a reload, and supports both dispose symbols', async () => {
    let finishReload: ((runtime: NativeRuntime) => void) | undefined;
    const recycled = fake({ memoryBytes: () => 1 });
    const reloaded = fake();
    const assimp = await entryWith(
      vi
        .fn<() => Promise<NativeRuntime>>()
        .mockResolvedValueOnce(recycled)
        .mockReturnValueOnce(
          new Promise((resolve) => {
            finishReload = resolve;
          }),
        ),
    ).createAssimp({ recycleAboveBytes: 0 });
    expect(assimp[Symbol.asyncDispose]).toBe(assimp.dispose);
    await assimp.convert(input, { to: 'glb' });
    expect(recycled.dispose).toHaveBeenCalledOnce();
    const pending = assimp.convert(input, { to: 'glb' });
    const disposed = vi.fn();
    assimp[Symbol.dispose]();
    void assimp.dispose().then(disposed);
    await new Promise<void>(setImmediate);
    expect(disposed).not.toHaveBeenCalled();
    finishReload?.(reloaded);
    await expect(pending).resolves.toMatchObject({ files: [] });
    await vi.waitFor(() => {
      expect(disposed).toHaveBeenCalledOnce();
    });
    expect(reloaded.dispose).toHaveBeenCalledOnce();
  });

  it('forwards onProgress through the singular call and returns the report', async () => {
    const reports: unknown[] = [];
    const runtime = fake({
      runPlan: async (_handle, context) => {
        context.reportProgress({ phase: 3, step: 4, total: 4, formatIndex: 0 });
        return 1;
      },
      peakMemoryBytes: () => 131_072,
    });
    await using assimp = await entryWith(async () => runtime).createAssimp();
    const result = await assimp.convert(input, {
      to: 'glb',
      onProgress: (progress) => reports.push(progress),
    });
    expect(result).toEqual({
      files: [],
      warnings: [],
      timings: { import: 0, postProcess: 0, export: 0, total: expect.any(Number) },
      peakMemoryBytes: 131_072,
    });
    expect(reports).toEqual([{ phase: 'export', step: 4, total: 4, formatIndex: 0, format: 'glb' }]);
  });

  it('compiles each Wasm source once and evicts a failed compile', async () => {
    const module = new WebAssembly.Module(testWasm);
    const url = new URL('https://example.test/cached.wasm');
    const compile = vi.fn(async () => module);
    await expect(compileCached(url, compile)).resolves.toBe(module);
    await expect(compileCached(new URL(url.href), compile)).resolves.toBe(module);
    expect(compile).toHaveBeenCalledOnce();

    const failing = new URL('https://example.test/failing.wasm');
    const broken = vi.fn(async () => Promise.reject(new Error('compile failed')));
    await expect(compileCached(failing, broken)).rejects.toThrow('compile failed');
    await expect(compileCached(failing, compile)).resolves.toBe(module);

    const binary = new Uint8Array(testWasm);
    const fromBytes = vi.fn(async () => module);
    await compileCached(binary, fromBytes);
    await compileCached(binary, fromBytes);
    expect(fromBytes).toHaveBeenCalledOnce();
    const brokenBinary = new Uint8Array(testWasm);
    await expect(compileCached(brokenBinary, broken)).rejects.toThrow('compile failed');
    await expect(compileCached(brokenBinary, fromBytes)).resolves.toBe(module);
  });
});
