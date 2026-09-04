import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ResolutionContext, type NativeRuntime } from './convert.js';
import { compileUrl, createEntry, isJspiAvailable, loadModule, missingImport } from './create-assimp.js';
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
      '3ds',
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
      'usdz',
      'x',
      'x3d',
    ]);
    expect(assimp.formats.import.map(({ id }) => id)).toContain('obj');
    expect(assimp.formats.export.find(({ id }) => id === 'stl')?.exportOptions).toHaveProperty('binary');
  });

  it('rejects forced native loading from the browser-safe entry', async () => {
    await expect(createAssimp({ backend: 'native' })).rejects.toMatchObject({
      message: 'backend: native is unavailable from the browser-safe libassimp entry.',
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
      'result.glb',
    );
  });

  it('instantiates the same artifact from wasmBinary', async () => {
    using assimp = await createAssimp({ wasmBinary: new Uint8Array(readFileSync(wasmPath)) });
    expect((await assimp.convert({ name: 'cube.obj', bytes: cube }, { to: 'glb' })).files[0]?.name).toBe(
      'result.glb',
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
    expect(secondSettled).toHaveBeenCalledWith({ files: [] });
    expect(runtime.preparePlan).toHaveBeenCalledTimes(2);

    assimp.dispose();
    expect(runtime.dispose).not.toHaveBeenCalled();
    release?.();
    await expect(first).resolves.toEqual({ files: [] });
    await new Promise<void>(setImmediate);
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
    assimp.dispose();
    await expect(assimp.convert({ name: 'cube.obj', bytes: cube }, { to: 'glb' })).rejects.toThrow(
      'assimp instance disposed',
    );
    release?.();
    expect((await first).files[0]?.name).toBe('result.glb');
    expect((await second).files[0]?.name).toBe('result.stl');
  });

  it('advances the queue after a resolver rejection', async () => {
    using assimp = await createAssimp();
    const failed = assimp.convert(
      { name: 'cube_usemtl.obj', bytes: model('OBJ/cube_usemtl.obj') },
      { to: 'glb', resolve: async () => Promise.reject(new Error('offline')) },
    );
    const next = assimp.convert({ name: 'cube.obj', bytes: cube }, { to: 'glb' });
    await expect(failed).rejects.toMatchObject({ code: 'RESOLVE_FAILED' });
    await expect(next).resolves.toMatchObject({ files: [{ name: 'result.glb' }] });
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
    for (const assimp of instances) assimp.dispose();
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
    ).resolves.toMatchObject({ files: [{ name: 'result.obj' }] });
    assimp.dispose();
    assimp.dispose();
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
    await expect(entry.convert({ name: 'cube.obj', bytes: cube }, { to: 'glb' })).resolves.toEqual({
      files: [],
    });
    await expect(entry.convert({ name: 'cube.obj', bytes: cube }, { to: 'glb' })).resolves.toEqual({
      files: [],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
