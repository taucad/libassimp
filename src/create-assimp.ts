/** One-artifact loading, automatic JSPI/replay selection, queues, and lifetime. */

import type {
  AssimpFile,
  ConvertFormatsOptions,
  ConvertFormatsResult,
  ConvertOptions,
  ConvertResult,
  ConvertTarget,
  NativeRuntime,
  WasmModule,
} from './convert.js';
import { prepareConversion, ResolutionContext, runPreparedConversion } from './convert.js';
import { AssimpError } from './assimp-error.js';
import type { AllExportFormat, ExportFormatInfo, FormatInfo } from './generated/assimp-capabilities.js';

/** Settings for {@link Assimp} creation. @public */
export type CreateAssimpOptions = {
  /** Runtime preference. Node defaults to `auto`; browsers always use Wasm. */
  readonly backend?: 'auto' | 'native' | 'wasm';
  /** Wasm location. Defaults to the single artifact shipped beside this entry. */
  readonly wasmUrl?: string | URL;
  /** Already-fetched bytes used instead of `wasmUrl`. */
  readonly wasmBinary?: ArrayBuffer | Uint8Array;
  /** Receives generated-runtime diagnostics. */
  readonly onLog?: (entry: {
    readonly level: 'info' | 'warning' | 'error';
    readonly message: string;
    readonly cause?: unknown;
  }) => void;
  /**
   * Wasm only: once a conversion leaves the instance idle with linear memory
   * above this size, the Wasm runtime is dropped and the next conversion starts
   * from a fresh, small heap (the compiled module is reused). Wasm memory never
   * shrinks in place, so without this a long-lived instance keeps its largest
   * heap forever. `Infinity` keeps the runtime. Bytes.
   *
   * @defaultValue 536870912 (512 MiB)
   */
  readonly recycleAboveBytes?: number;
};

/** Singular conversion callable narrowed to one package entry. @public */
export type ConvertFunction<ExportFormat extends AllExportFormat> = <Format extends ExportFormat>(
  files: AssimpFile | readonly AssimpFile[],
  options: ConvertOptions<Format>,
) => Promise<ConvertResult>;

/** Positional plural conversion callable narrowed to one package entry. @public */
export type ConvertFormatsFunction<ExportFormat extends AllExportFormat> = <
  const Targets extends readonly [ConvertTarget<ExportFormat>, ...ConvertTarget<ExportFormat>[]],
>(
  files: AssimpFile | readonly AssimpFile[],
  options: ConvertFormatsOptions<Targets>,
) => Promise<ConvertFormatsResult<Targets>>;

/** Loaded conversion instance. @public */
export type Assimp<ImportFormat extends string, ExportFormat extends AllExportFormat> = {
  /** Runtime that actually serves this instance. */
  readonly backend: 'native' | 'wasm';
  /** Native target/API identity, absent for Wasm instances. */
  readonly buildIdentity?: string;
  readonly convert: ConvertFunction<ExportFormat>;
  readonly convertFormats: ConvertFormatsFunction<ExportFormat>;
  readonly formats: {
    readonly import: readonly FormatInfo<ImportFormat>[];
    readonly export: readonly ExportFormatInfo<ExportFormat>[];
  };
  /**
   * Stop accepting conversions, let queued ones finish, then release the
   * runtime. Settles once the queue has drained. Calling it again returns the
   * same promise.
   */
  readonly dispose: () => Promise<void>;
  /** `await using` support: the same as {@link Assimp.dispose}. */
  readonly [Symbol.asyncDispose]: () => Promise<void>;
  /** `using` support: starts {@link Assimp.dispose} without waiting for the drain. */
  readonly [Symbol.dispose]: () => void;
};

type ModuleOptions = {
  readonly locateFile: () => string;
  readonly print: (message: string) => void;
  readonly printErr: (message: string) => void;
  readonly instantiateWasm: (
    imports: WebAssembly.Imports,
    receive: (instance: WebAssembly.Instance) => void,
  ) => WebAssembly.Exports;
};

type ModuleFactory = (options: ModuleOptions) => Promise<WasmModule>;

type JspiWebAssembly = typeof WebAssembly & {
  readonly Suspending?: new (
    callback: (...arguments_: number[]) => number | Promise<number>,
  ) => WebAssembly.ImportValue;
  readonly promising?: (callback: (handle: number) => number) => (handle: number) => Promise<number>;
};

type EntryFormats<ImportFormat extends string, ExportFormat extends AllExportFormat> = Readonly<{
  import: readonly FormatInfo<ImportFormat>[];
  export: readonly ExportFormatInfo<ExportFormat>[];
}>;

type EntryConfig<ImportFormat extends string, ExportFormat extends AllExportFormat> = EntryFormats<
  ImportFormat,
  ExportFormat
> &
  Readonly<{ loadRuntime?: RuntimeLoader }>;

/** Create one loaded runtime for a package entry. @internal */
export type RuntimeLoader = (options: CreateAssimpOptions) => Promise<NativeRuntime>;

const sink =
  (onLog: CreateAssimpOptions['onLog'], level: 'info' | 'error') =>
  (message: string): void => {
    onLog?.({ level, message });
  };

const wasmSourceUrl = (configured: string | URL | undefined, fallback: URL): URL => {
  if (configured instanceof URL) return configured;
  return configured === undefined ? fallback : new URL(configured, fallback);
};

/** Compile a URL with a byte fallback for hosts without streaming compilation. @internal */
export const compileUrl = async (url: URL): Promise<WebAssembly.Module> => {
  if (url.protocol === 'file:' && 'process' in globalThis) {
    // Built at run time so bundlers targeting browsers (esbuild's default) never
    // try to resolve a Node built-in; this branch only runs on Node.
    const { readFile } = (await import(
      /* webpackIgnore: true */ /* @vite-ignore */ ['node', 'fs/promises'].join(':')
    )) as typeof import('node:fs/promises');
    return WebAssembly.compile(await readFile(url));
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url.href}: ${response.status} ${response.statusText}`);
  try {
    return await WebAssembly.compileStreaming(Promise.resolve(response.clone()));
  } catch {
    return WebAssembly.compile(await response.arrayBuffer());
  }
};

const compiledByUrl = new Map<string, Promise<WebAssembly.Module>>();
const compiledByBinary = new WeakMap<object, Promise<WebAssembly.Module>>();

/**
 * Compile each Wasm source once per realm, so recycling or replacing a runtime
 * only instantiates. A failed compile is not cached. @internal
 */
export const compileCached = (
  source: URL | ArrayBuffer | Uint8Array,
  compile: () => Promise<WebAssembly.Module>,
): Promise<WebAssembly.Module> => {
  const cached = source instanceof URL ? compiledByUrl.get(source.href) : compiledByBinary.get(source);
  if (cached !== undefined) return cached;
  const compiling = compile();
  if (source instanceof URL) compiledByUrl.set(source.href, compiling);
  else compiledByBinary.set(source, compiling);
  compiling.catch(() => {
    if (source instanceof URL) compiledByUrl.delete(source.href);
    else compiledByBinary.delete(source);
  });
  return compiling;
};

/** Report whether the host exposes both JSPI primitives used by libassimp. @internal */
export const isJspiAvailable = (): boolean => {
  const wasm = WebAssembly as JspiWebAssembly;
  return typeof wasm.Suspending === 'function' && typeof wasm.promising === 'function';
};

/** Find the artifact's single unsupplied host-function import. @internal */
export const missingImport = (
  compiled: WebAssembly.Module,
  imports: WebAssembly.Imports,
): WebAssembly.ModuleImportDescriptor => {
  const mutable = imports;
  const missing = WebAssembly.Module.imports(compiled).filter(({ kind, module, name }) => {
    const supplied = mutable[module]?.[name];
    if (kind === 'function') return typeof supplied !== 'function';
    return supplied === undefined;
  });
  if (missing.length !== 1 || missing[0]?.kind !== 'function') {
    throw new Error(
      `libassimp artifact invariant failed: expected one host function import, found ${missing.length}.`,
    );
  }
  return missing[0];
};

/** Load and bind one generated glue/Wasm pair. @internal */
export const loadModule = async (
  glueUrl: URL,
  defaultWasmUrl: URL,
  options: CreateAssimpOptions,
): Promise<NativeRuntime> => {
  try {
    const source = options.wasmBinary ?? wasmSourceUrl(options.wasmUrl, defaultWasmUrl);
    const compiled = await compileCached(source, () =>
      source instanceof URL ? compileUrl(source) : WebAssembly.compile(source as BufferSource),
    );
    const glue = (await import(/* webpackIgnore: true */ /* @vite-ignore */ glueUrl.href)) as {
      default: ModuleFactory;
    };
    const jspi = isJspiAvailable();
    const runtimeState: { instance?: WebAssembly.Instance; memory?: WebAssembly.Memory } = {};
    let resolveInstantiation: (value: WebAssembly.Instance | PromiseLike<WebAssembly.Instance>) => void;
    const instantiationRequested = new Promise<WebAssembly.Instance>((resolve) => {
      resolveInstantiation = resolve;
    });
    let active: ResolutionContext | undefined;
    const dispatch = (operation: number, first: number, second: number): number | Promise<number> => {
      if (active === undefined || runtimeState.memory === undefined) {
        throw new Error('libassimp host dispatch called outside an active conversion.');
      }
      return active.dispatch({
        operation,
        first,
        second,
        memory: runtimeState.memory,
        suspending: jspi,
      });
    };

    const nativePromise = glue.default({
      locateFile: () => wasmSourceUrl(options.wasmUrl, defaultWasmUrl).href,
      print: sink(options.onLog, 'info'),
      printErr: sink(options.onLog, 'error'),
      instantiateWasm: (baseImports, receive) => {
        const descriptor = missingImport(compiled, baseImports);
        const imports = baseImports;
        const moduleImports = (imports[descriptor.module] ??= {});
        const wasm = WebAssembly as JspiWebAssembly;
        moduleImports[descriptor.name] =
          jspi && wasm.Suspending !== undefined ? new wasm.Suspending(dispatch) : dispatch;
        const instantiation = WebAssembly.instantiate(compiled, baseImports).then((instance) => {
          runtimeState.instance = instance;
          receive(instance);
          return instance;
        });
        resolveInstantiation(instantiation);
        return {};
      },
    });
    const instance = await Promise.race([
      instantiationRequested,
      nativePromise.then(() => {
        throw new Error('libassimp glue did not request Wasm instantiation.');
      }),
    ]);
    const native = await nativePromise;
    const memoryExport = WebAssembly.Module.exports(compiled).find(({ kind }) => kind === 'memory');
    const rawExport = native._libassimp_run_plan;
    const foundMemory = memoryExport && instance.exports[memoryExport.name];
    if (!(foundMemory instanceof WebAssembly.Memory) || typeof rawExport !== 'function') {
      throw new Error('libassimp artifact is missing its memory or stable raw plan export.');
    }
    runtimeState.memory = foundMemory;
    const raw = rawExport;
    const wasm = WebAssembly as JspiWebAssembly;
    const invoke = jspi && wasm.promising !== undefined ? wasm.promising(raw) : raw;
    return {
      backend: 'wasm',
      // With JSPI a run never replays, so the engine may drop the entry file once it is imported.
      preparePlan: (entryName, files, nativeOptions) =>
        native.preparePlan(entryName, files, { ...nativeOptions, releaseEntry: jspi }),
      runPlan: async (handle, context) => {
        if (active !== undefined) throw new Error('libassimp instance re-entry is not allowed.');
        active = context;
        try {
          return await invoke(handle as number);
        } finally {
          active = undefined;
        }
      },
      takePlanResult: (handle) => native.takePlanResult(handle as number),
      cancelPlan: () => undefined,
      destroyPlan: (handle) => {
        native.destroyPlan(handle as number);
      },
      // Dropping the instance and memory lets GC return the linear memory, which never shrinks in place.
      dispose: () => {
        delete runtimeState.instance;
        delete runtimeState.memory;
      },
      memoryBytes: () => foundMemory.buffer.byteLength,
      peakMemoryBytes: () => foundMemory.buffer.byteLength,
    };
  } catch (error) {
    options.onLog?.({ level: 'error', message: error instanceof Error ? error.message : String(error) });
    throw error;
  }
};

const disposedError = (): Error => new Error('assimp instance disposed; create another with createAssimp().');

/** Bench-only probe of the runtime's memory; not part of the public API. @internal */
const memoryBytesKey: unique symbol = Symbol.for('libassimp.memoryBytes');

/** Default {@link CreateAssimpOptions.recycleAboveBytes}. @internal */
const defaultRecycleAboveBytes = 512 * 1024 * 1024;

const waitFor = <Value>(start: () => Promise<Value>, signal: AbortSignal | undefined): Promise<Value> => {
  if (signal === undefined) return start();
  return new Promise((resolve, reject) => {
    let watched: AbortSignal | undefined = signal;
    const stop = (): void => {
      watched?.removeEventListener('abort', abort);
      watched = undefined;
    };
    const abort = (): void => {
      const reason: unknown = watched?.reason;
      stop();
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      reject(reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    start().then(
      (value) => {
        stop();
        resolve(value);
      },
      (error: unknown) => {
        stop();
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(error);
      },
    );
  });
};

const validateCreateOptions = (options: CreateAssimpOptions): void => {
  const backend: unknown = options.backend;
  if (backend !== undefined && backend !== 'auto' && backend !== 'native' && backend !== 'wasm') {
    throw new AssimpError('INVALID_OPTIONS', 'Invalid backend; expected auto, native, or wasm.');
  }
  const recycle: unknown = options.recycleAboveBytes;
  if (recycle !== undefined && (typeof recycle !== 'number' || Number.isNaN(recycle) || recycle < 0)) {
    throw new AssimpError(
      'INVALID_OPTIONS',
      'Invalid recycleAboveBytes; expected a non-negative number of bytes, or Infinity to keep the runtime.',
    );
  }
};

/** Bind one package entry to its artifact and generated static format tables. @internal */
export const createEntry = <ImportFormat extends string, ExportFormat extends AllExportFormat>(
  glueUrl: URL,
  wasmUrl: URL,
  config: EntryConfig<ImportFormat, ExportFormat>,
) => {
  const formats: EntryFormats<ImportFormat, ExportFormat> = {
    import: config.import,
    export: config.export,
  };
  const loadRuntime: RuntimeLoader =
    config.loadRuntime ??
    ((options) => {
      if (options.backend === 'native') {
        return Promise.reject(
          new AssimpError(
            'BACKEND_UNAVAILABLE',
            "backend: native is unavailable from the browser-safe libassimp entry; use backend: 'auto' or 'wasm', or import libassimp from Node.js.",
            { cause: new Error('The default libassimp entry contains no Node loader.') },
          ),
        );
      }
      return loadModule(glueUrl, wasmUrl, options);
    });
  const supportedFormats = new Set<string>(formats.export.map(({ id }) => id));
  const createAssimp = async (
    options: CreateAssimpOptions = {},
  ): Promise<Assimp<ImportFormat, ExportFormat>> => {
    validateCreateOptions(options);
    const recycleAboveBytes = options.recycleAboveBytes ?? defaultRecycleAboveBytes;
    const first = await loadRuntime(options);
    const backend = first.backend;
    // A Wasm runtime is replaced after a trap and recycled when idle and large; both reload
    // lazily, from the cached compiled module, on the next conversion. A Wasm reload always
    // stays on Wasm because the Node loader only falls back from native to Wasm.
    const reloadOptions: CreateAssimpOptions = { ...options, backend };
    let runtime: NativeRuntime | undefined = first;
    let loading: Promise<NativeRuntime> | undefined;
    let disposed: Promise<void> | undefined;
    let drain: Promise<void> = Promise.resolve();
    let active = 0;
    const serialize = backend === 'wasm';

    const acquire = (): Promise<NativeRuntime> => {
      if (runtime !== undefined) return Promise.resolve(runtime);
      loading ??= loadRuntime(reloadOptions).then(
        (loaded) => {
          loading = undefined;
          runtime = loaded;
          return loaded;
        },
        (error: unknown) => {
          loading = undefined;
          throw error;
        },
      );
      return loading;
    };

    const discard = (): void => {
      runtime?.dispose();
      runtime = undefined;
    };

    const execute = async <Result>(job: (current: NativeRuntime) => Promise<Result>): Promise<Result> => {
      active += 1;
      let current: NativeRuntime | undefined;
      try {
        current = await acquire();
        return await job(current);
      } catch (error) {
        const trapped = error instanceof AssimpError && error.code === 'ENGINE_FAILED';
        if (serialize && trapped && runtime === current) discard();
        throw error;
      } finally {
        active -= 1;
        const bytes = runtime === current ? runtime?.memoryBytes?.() : undefined;
        if (active === 0 && bytes !== undefined && bytes > recycleAboveBytes) discard();
      }
    };

    const run = <Result>(operation: () => Promise<Result>, signal: AbortSignal | undefined) => {
      const predecessor = drain;
      const result = serialize ? waitFor(() => predecessor, signal).then(operation) : operation();
      const settled = result.then(
        () => undefined,
        () => undefined,
      );
      drain = Promise.all([predecessor, settled]).then(() => undefined);
      return result;
    };

    const convertFormats: ConvertFormatsFunction<ExportFormat> = (files, convertOptions) => {
      if (disposed !== undefined) return Promise.reject(disposedError());
      // AbortSignal.reason is deliberately not constrained to Error.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      if (convertOptions.signal?.aborted) return Promise.reject(convertOptions.signal.reason);
      let request;
      try {
        request = prepareConversion(files, convertOptions, supportedFormats);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      return run(() => execute((current) => runPreparedConversion(current, request)), convertOptions.signal);
    };

    const convert: ConvertFunction<ExportFormat> = (files, convertOptions) => {
      const target = {
        to: convertOptions.to,
        ...(convertOptions.exportOptions === undefined
          ? {}
          : { exportOptions: convertOptions.exportOptions }),
      } as ConvertTarget<ExportFormat>;
      const plural = {
        targets: [target] as [ConvertTarget<ExportFormat>],
        ...(convertOptions.resolve === undefined ? {} : { resolve: convertOptions.resolve }),
        ...(convertOptions.signal === undefined ? {} : { signal: convertOptions.signal }),
        ...(convertOptions.onProgress === undefined ? {} : { onProgress: convertOptions.onProgress }),
        ...(convertOptions.importOptions === undefined
          ? {}
          : { importOptions: convertOptions.importOptions }),
        ...(convertOptions.postProcess === undefined ? {} : { postProcess: convertOptions.postProcess }),
      };
      return convertFormats(files, plural).then((result) => ({
        files: result[0].files,
        warnings: result.warnings,
        timings: result.timings,
        peakMemoryBytes: result.peakMemoryBytes,
      }));
    };

    // Every reload starts inside a queued job, so once the drain settles no reload is in flight.
    const dispose = (): Promise<void> =>
      (disposed ??= drain.then(() => {
        discard();
      }));

    const assimp: Assimp<ImportFormat, ExportFormat> = {
      backend,
      ...(first.buildIdentity === undefined ? {} : { buildIdentity: first.buildIdentity }),
      convert,
      convertFormats,
      formats,
      dispose,
      [Symbol.asyncDispose]: dispose,
      [Symbol.dispose]: () => {
        void dispose();
      },
    };
    Object.defineProperty(assimp, memoryBytesKey, { value: () => runtime?.memoryBytes?.() });
    return assimp;
  };

  let shared: Promise<Assimp<ImportFormat, ExportFormat>> | undefined;
  const instance = (): Promise<Assimp<ImportFormat, ExportFormat>> =>
    (shared ??= createAssimp().catch((error: unknown) => {
      shared = undefined;
      throw error;
    }));
  // The shared instance recycles and replaces its Wasm runtime like any other instance.
  const convert: ConvertFunction<ExportFormat> = (files, options) =>
    waitFor(instance, options.signal).then((assimp) => assimp.convert(files, options));
  const convertFormats: ConvertFormatsFunction<ExportFormat> = (files, options) =>
    waitFor(instance, options.signal).then((assimp) => assimp.convertFormats(files, options));

  return { convert, convertFormats, createAssimp };
};
