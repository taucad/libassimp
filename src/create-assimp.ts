/**
 * Loading and lifetime for one compiled variant: the bundler-opaque glue
 * import, the instance façade, and the lazy instance every one-shot `convert`
 * shares. Each entry module binds this to its own pair of artifact URLs.
 */

import type { AssimpFile, ConvertOptions, ConvertResult, NativeModule } from './convert.js';
import { runConvert } from './convert.js';
import type { FormatInfo } from './formats.js';

/**
 * Settings for {@link Assimp} creation.
 *
 * @public
 */
export type CreateAssimpOptions = {
  /**
   * Where to fetch this entry's `.wasm`. Defaults to the binary shipped beside
   * the entry module, which Node resolves directly and a bundler emits as an
   * asset. Point it at your own copy when you serve the binary from a CDN or a
   * hashed asset directory.
   */
  wasmUrl?: string | URL;
  /** Already-fetched binary, used instead of fetching `wasmUrl`. */
  wasmBinary?: ArrayBuffer | Uint8Array;
  /**
   * Receives the compiled module's diagnostic lines. Without it they are
   * dropped; a failure that stops a conversion is thrown, never only logged.
   */
  onLog?: (entry: { level: 'info' | 'error'; message: string }) => void;
};

/**
 * A loaded conversion instance: one compiled module reused across calls, with
 * a lifetime you control. The one-shot `convert` shares an instance of its own.
 *
 * @public
 */
export type Assimp<Format extends string = string> = {
  /** Convert files on this instance. Rejects once the instance is disposed. */
  readonly convert: (
    files: AssimpFile | readonly AssimpFile[],
    options: ConvertOptions<Format>,
  ) => Promise<ConvertResult>;
  /** The formats this entry was compiled with, one entry per id. */
  readonly formats: {
    readonly import: readonly FormatInfo[];
    readonly export: readonly FormatInfo[];
  };
  /**
   * Release the instance. Later `convert` calls reject with an `Error`, so
   * create a new instance rather than retrying on this one.
   */
  readonly dispose: () => void;
  /** `using assimp = await createAssimp()` disposes at scope exit. */
  readonly [Symbol.dispose]: () => void;
};

/** Emscripten module overrides this wrapper sets. @internal */
type ModuleOptions = {
  readonly locateFile: () => string;
  readonly print: (message: string) => void;
  readonly printErr: (message: string) => void;
  readonly instantiateWasm?: (
    imports: WebAssembly.Imports,
    receive: (instance: WebAssembly.Instance) => void,
  ) => void;
};

/** The `-sMODULARIZE -sEXPORT_ES6` default export. @internal */
type ModuleFactory = (options: ModuleOptions) => Promise<NativeModule>;

/** One diagnostic sink per Emscripten stream. */
const sink =
  (onLog: CreateAssimpOptions['onLog'], level: 'info' | 'error') =>
  (message: string): void => {
    onLog?.({ level, message });
  };

/** Keep the first description of each id; importers repeat shared extensions. */
const unique = (formats: readonly FormatInfo[]): readonly FormatInfo[] => {
  const byId = new Map<string, FormatInfo>();
  for (const format of formats) {
    if (!byId.has(format.id)) byId.set(format.id, format);
  }
  return [...byId.values()];
};

const loadModule = async (
  glueUrl: URL,
  wasmUrl: URL,
  options: CreateAssimpOptions,
): Promise<NativeModule> => {
  // Imported through its own URL so a bundler emits the glue as an asset
  // instead of following the edge and pulling every variant's Emscripten
  // runtime — and its Node branches — into the application graph.
  const glue = (await import(/* webpackIgnore: true */ /* @vite-ignore */ glueUrl.href)) as {
    default: ModuleFactory;
  };
  // `BufferSource` excludes views over a `SharedArrayBuffer`, which no caller
  // hands to a loader; the public option stays the plain `Uint8Array` a file
  // read returns.
  const wasmBinary = options.wasmBinary as BufferSource | undefined;
  return glue.default({
    locateFile: () => (options.wasmUrl ?? wasmUrl).toString(),
    print: sink(options.onLog, 'info'),
    printErr: sink(options.onLog, 'error'),
    ...(wasmBinary === undefined
      ? {}
      : {
          instantiateWasm: (imports, receive) => {
            void WebAssembly.instantiate(wasmBinary, imports).then(({ instance }) => {
              receive(instance);
            });
          },
        }),
  });
};

/**
 * Bind one compiled variant to its artifact URLs.
 *
 * @internal
 * @param glueUrl - This variant's Emscripten glue module.
 * @param wasmUrl - This variant's binary, the `wasmUrl` default.
 * @returns The entry's `createAssimp` and one-shot `convert`.
 */
export const createEntry = <Format extends string>(glueUrl: URL, wasmUrl: URL) => {
  const createAssimp = async (options: CreateAssimpOptions = {}): Promise<Assimp<Format>> => {
    const native = await loadModule(glueUrl, wasmUrl, options);
    const tables = native.formats();
    let disposed = false;
    const dispose = (): void => {
      disposed = true;
    };
    return {
      // eslint-disable-next-line @typescript-eslint/require-await -- `async` turns the disposed throw into the rejection the type promises.
      convert: async (files, convertOptions) => {
        if (disposed) {
          throw new Error('assimp instance disposed; create another with createAssimp().');
        }
        return runConvert(native, files, convertOptions);
      },
      formats: { import: unique(tables.import), export: unique(tables.export) },
      dispose,
      [Symbol.dispose]: dispose,
    };
  };

  // ponytail: no reset on a failed bring-up. The only way loading fails is an
  // unreachable or invalid binary, which the next call would hit again.
  let shared: Promise<Assimp<Format>> | undefined;
  const convert = async (
    files: AssimpFile | readonly AssimpFile[],
    options: ConvertOptions<Format>,
  ): Promise<ConvertResult> => {
    shared ??= createAssimp();
    return (await shared).convert(files, options);
  };

  return { convert, createAssimp };
};
