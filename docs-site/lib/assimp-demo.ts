import { createAssimp, type Assimp } from 'libassimp';

let loaded: Promise<Assimp> | undefined;

/** Whether this document has already started or completed module loading. */
export const isAssimpLoaded = (): boolean => loaded !== undefined;

/** Load the self-hosted artifact once per document, clearing failed attempts for retry. */
export const loadAssimp = async (): Promise<Assimp> => {
  loaded ??= createAssimp({ wasmUrl: new URL('/demo/libassimp.wasm', document.baseURI) }).catch(
    (error: unknown) => {
      loaded = undefined;
      throw error;
    },
  );
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
