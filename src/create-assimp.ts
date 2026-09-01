/** One-artifact loading, automatic JSPI/replay selection, queues, and lifetime. */

import type {
  AssimpFile,
  ConvertFormatsOptions,
  ConvertFormatsResult,
  ConvertOptions,
  ConvertResult,
  ConvertTarget,
  NativeModule,
  NativeRuntime,
} from './convert.js';
import { prepareConversion, ResolutionContext, runPreparedConversion } from './convert.js';
import type { AllExportFormat, ExportFormatInfo, FormatInfo } from './generated/assimp-capabilities.js';

/** Settings for {@link Assimp} creation. @public */
export type CreateAssimpOptions = {
  /** Wasm location. Defaults to the single artifact shipped beside this entry. */
  readonly wasmUrl?: string | URL;
  /** Already-fetched bytes used instead of `wasmUrl`. */
  readonly wasmBinary?: ArrayBuffer | Uint8Array;
  /** Receives generated-runtime diagnostics. */
  readonly onLog?: (entry: { readonly level: 'info' | 'error'; readonly message: string }) => void;
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
  readonly convert: ConvertFunction<ExportFormat>;
  readonly convertFormats: ConvertFormatsFunction<ExportFormat>;
  readonly formats: {
    readonly import: readonly FormatInfo<ImportFormat>[];
    readonly export: readonly ExportFormatInfo<ExportFormat>[];
  };
  readonly dispose: () => void;
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

type ModuleFactory = (options: ModuleOptions) => Promise<NativeModule>;

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
    const { readFile } = await import(/* webpackIgnore: true */ /* @vite-ignore */ 'node:fs/promises');
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
    const compiled =
      options.wasmBinary === undefined
        ? await compileUrl(wasmSourceUrl(options.wasmUrl, defaultWasmUrl))
        : await WebAssembly.compile(options.wasmBinary as BufferSource);
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
      native,
      runPlan: async (handle, context) => {
        if (active !== undefined) throw new Error('libassimp instance re-entry is not allowed.');
        active = context;
        try {
          return await invoke(handle);
        } finally {
          active = undefined;
        }
      },
    };
  } catch (error) {
    options.onLog?.({ level: 'error', message: error instanceof Error ? error.message : String(error) });
    throw error;
  }
};

const disposedError = (): Error => new Error('assimp instance disposed; create another with createAssimp().');

/** Bind one package entry to its artifact and generated static format tables. @internal */
export const createEntry = <ImportFormat extends string, ExportFormat extends AllExportFormat>(
  glueUrl: URL,
  wasmUrl: URL,
  formats: EntryFormats<ImportFormat, ExportFormat>,
) => {
  const supportedFormats = new Set<string>(formats.export.map(({ id }) => id));
  const createAssimp = async (
    options: CreateAssimpOptions = {},
  ): Promise<Assimp<ImportFormat, ExportFormat>> => {
    let runtime: NativeRuntime | undefined = await loadModule(glueUrl, wasmUrl, options);
    let disposed = false;
    let tail: Promise<void> = Promise.resolve();

    const enqueue = <Result>(operation: () => Promise<Result>): Promise<Result> => {
      const result = tail.then(operation);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };

    const convertFormats: ConvertFormatsFunction<ExportFormat> = (files, convertOptions) => {
      if (disposed) return Promise.reject(disposedError());
      let request;
      try {
        request = prepareConversion(files, convertOptions, supportedFormats);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      return enqueue(() => runPreparedConversion(runtime as NativeRuntime, request));
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
        ...(convertOptions.importOptions === undefined
          ? {}
          : { importOptions: convertOptions.importOptions }),
        ...(convertOptions.postProcess === undefined ? {} : { postProcess: convertOptions.postProcess }),
      };
      return convertFormats(files, plural).then(([result]) => ({ files: result.files }));
    };

    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      void tail.then(() => {
        runtime = undefined;
      });
    };

    return {
      convert,
      convertFormats,
      formats,
      dispose,
      [Symbol.dispose]: dispose,
    };
  };

  let shared: Promise<Assimp<ImportFormat, ExportFormat>> | undefined;
  const instance = (): Promise<Assimp<ImportFormat, ExportFormat>> =>
    (shared ??= createAssimp().catch((error: unknown) => {
      shared = undefined;
      throw error;
    }));
  const convert: ConvertFunction<ExportFormat> = async (files, options) =>
    (await instance()).convert(files, options);
  const convertFormats: ConvertFormatsFunction<ExportFormat> = async (files, options) =>
    (await instance()).convertFormats(files, options);

  return { convert, convertFormats, createAssimp };
};
