import type { AssimpFile } from 'libassimp/importer';

import sizes from './sizes.json';

/**
 * The compiled `libassimp/importer` binding, as the demo calls it. The package entry resolves its
 * own glue beside `dist/`, which a bundled page cannot reach, so the demo loads the published
 * artifacts from a CDN and calls the embind function directly. The shape mirrors
 * `src/cpp/libassimp.cpp`.
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

/** The version this build documents, written into `sizes.json` from the root manifest. */
export const packageVersion = sizes.version;

// jsDelivr's copy of the published package, pinned to that version. Both URLs are absolute, so
// neither the glue nor its binary can resolve against the documentation origin.
const cdn = `https://cdn.jsdelivr.net/npm/libassimp@${packageVersion}/dist/wasm/`;

let loaded: Promise<NativeModule> | undefined;

/**
 * Load the published importer build, once per document.
 *
 * A failed load clears the cache instead of sticking in it, so pressing the button again retries
 * rather than replaying the first failure forever.
 */
export const loadAssimp = async (): Promise<NativeModule> => {
  loaded ??= (async () => {
    const glue = (await import(/* webpackIgnore: true */ `${cdn}libassimp-importer.js`)) as {
      default: ModuleFactory;
    };
    return glue.default({ locateFile: () => `${cdn}libassimp-importer.wasm` });
  })().catch((error: unknown) => {
    loaded = undefined;
    throw error;
  });
  return loaded;
};

/** True when the host can instantiate WebAssembly at all. */
export const hasWebAssembly = (): boolean => typeof WebAssembly === 'object';
