import type { AssimpFile } from 'libassimp/importer';

/**
 * The compiled `libassimp/importer` binding, as the demo calls it. The package entry resolves its
 * own glue beside `dist/`, which a bundled page cannot reach, so the demo loads the same artifacts
 * from `/demo/` and calls the embind function directly. The shape mirrors `src/cpp/libassimp.cpp`.
 */
type NativeModule = {
  // oxlint-disable-next-line max-params -- the embind signature this type describes.
  readonly convert: (
    entryName: string,
    files: readonly AssimpFile[],
    format: string,
    properties: Record<string, boolean | number | string>,
    resolve: ((name: string) => Uint8Array | undefined) | undefined,
  ) => {
    readonly ok: boolean;
    readonly code: string;
    readonly message: string;
    readonly files: AssimpFile[];
  };
};

type ModuleFactory = (options: { readonly locateFile: () => string }) => Promise<NativeModule>;

const assetUrl = (name: string): string => new URL(`/demo/${name}`, window.location.href).href;

let loaded: Promise<NativeModule> | undefined;

/**
 * Load the importer build served from `/demo/`, once per document.
 *
 * A failed load clears the cache instead of sticking in it, so pressing the button again retries
 * rather than replaying the first failure forever.
 */
export const loadAssimp = async (): Promise<NativeModule> => {
  loaded ??= (async () => {
    const glue = (await import(/* webpackIgnore: true */ assetUrl('libassimp-importer.js'))) as {
      default: ModuleFactory;
    };
    return glue.default({ locateFile: () => assetUrl('libassimp-importer.wasm') });
  })().catch((error: unknown) => {
    loaded = undefined;
    throw error;
  });
  return loaded;
};

/** True when the host can instantiate WebAssembly at all. */
export const hasWebAssembly = (): boolean => typeof WebAssembly === 'object';
