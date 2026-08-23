import type { AssimpFile } from 'libassimp/importer';

/**
 * The compiled full binding, as the demo calls it. The docs self-host the same
 * checked-in glue and binary nanoraster uses for its live pages, so demos work
 * before an npm release and remain pinned to the commit being documented.
 */
export type NativeModule = {
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

const demoRoot = '/demo/';

let loaded: Promise<NativeModule> | undefined;

/** Whether this document has already started or completed module loading. */
export const isAssimpLoaded = (): boolean => loaded !== undefined;

/** Load the self-hosted full build once per document, clearing a failed attempt so retry works. */
export const loadAssimp = async (): Promise<NativeModule> => {
  loaded ??= (async () => {
    const glue = (await import(/* webpackIgnore: true */ `${demoRoot}libassimp-full.js`)) as {
      default: ModuleFactory;
    };
    return glue.default({ locateFile: () => `${demoRoot}libassimp-full.wasm` });
  })().catch((error: unknown) => {
    loaded = undefined;
    throw error;
  });
  return loaded;
};

/** True when the host can instantiate WebAssembly at all. */
export const hasWebAssembly = (): boolean => typeof WebAssembly === 'object';

/** True when this Apple host advertises AR Quick Look for `rel="ar"` links. */
export const hasQuickLook = (): boolean => {
  if (typeof document === 'undefined' || typeof navigator === 'undefined') return false;
  const ios =
    (/iPad|iPhone|iPod/u.test(navigator.userAgent) && !('MSStream' in globalThis)) ||
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- Apple exposes no replacement.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!ios) return false;
  const anchor = document.createElement('a');
  return (
    anchor.relList.supports('ar') || /CriOS\/|EdgiOS\/|FxiOS\/|GSA\/|DuckDuckGo\//u.test(navigator.userAgent)
  );
};

/** Open one USDZ object URL through Apple AR Quick Look. */
export const launchQuickLook = (url: string): void => {
  const anchor = document.createElement('a');
  anchor.rel = 'ar';
  anchor.href = url;
  anchor.download = 'model.usdz';
  anchor.append(document.createElement('img'));
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
};
