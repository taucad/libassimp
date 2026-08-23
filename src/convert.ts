/**
 * The conversion request and its result, plus the call into the compiled
 * binding. One embind function does the whole job and hands back copied bytes,
 * so a result is plain data with nothing to free.
 */

import { AssimpError, type AssimpFailureCode } from './assimp-error.js';
import type { FormatInfo } from './formats.js';

/**
 * One named payload: an input file, or an output file a conversion produced.
 *
 * @public
 */
export type AssimpFile = {
  /** File name assimp resolves references against, such as `model.obj`. */
  readonly name: string;
  /** File contents. Output bytes are copies owned by the caller. */
  readonly bytes: Uint8Array;
};

/**
 * Settings for one conversion.
 *
 * @public
 */
export type ConvertOptions<Format extends string = string> = {
  /**
   * Target format id. The output file is named `result.<extension>` with the
   * extension assimp's exporter table gives that id, so `step` writes
   * `result.stp` and `assjson` writes `result.json`.
   */
  to: Format;
  /**
   * Loader for files the model references but `files` does not carry, such as
   * an OBJ material library or a glTF buffer. Synchronous by contract, because
   * assimp asks for a reference in the middle of parsing: read or cache the
   * bytes before calling `convert`. Return `undefined` for names you cannot
   * supply, which fails the import only if assimp needed them.
   */
  resolve?: (name: string) => Uint8Array | undefined;
  /**
   * Assimp export properties passed to the exporter verbatim, such as
   * `{ '3MF_EXPORT_UNIT': 'meter' }`. Keys the exporter does not recognize are
   * ignored; a recognized key with a rejected value fails with `EXPORT_FAILED`.
   */
  properties?: Record<string, boolean | number | string>;
};

/**
 * The files one conversion produced: the primary output first, then any
 * sidecars the exporter wrote, such as a glTF `.bin` or an OBJ `.mtl`.
 *
 * @public
 */
export type ConvertResult = { readonly files: readonly AssimpFile[] };

/** Result shape `convert` in `src/cpp/libassimp.cpp` returns. @internal */
type NativeResult =
  | { readonly ok: true; readonly code: ''; readonly message: string; readonly files: AssimpFile[] }
  | {
      readonly ok: false;
      readonly code: AssimpFailureCode;
      readonly message: string;
      readonly files: AssimpFile[];
    };

/** The two embind functions the compiled module exposes. @internal */
export type NativeModule = {
  // oxlint-disable-next-line max-params -- the embind signature this type describes.
  readonly convert: (
    entryName: string,
    files: readonly AssimpFile[],
    format: string,
    properties: Record<string, boolean | number | string>,
    resolve: ((name: string) => Uint8Array | undefined) | undefined,
  ) => NativeResult;
  readonly formats: () => {
    readonly import: readonly FormatInfo[];
    readonly export: readonly FormatInfo[];
  };
};

/**
 * Run one conversion against a loaded module, mapping a failure to a typed
 * {@link AssimpError}.
 *
 * @internal
 * @param native - The loaded binding.
 * @param files - The entry file, or files whose first element is the entry.
 * @param options - Target format and per-call settings.
 * @returns The output files.
 */
export const runConvert = (
  native: NativeModule,
  files: AssimpFile | readonly AssimpFile[],
  options: ConvertOptions,
): ConvertResult => {
  const list = 'name' in files ? [files] : files;
  const result = native.convert(
    list[0]?.name ?? '',
    list,
    options.to,
    options.properties ?? {},
    options.resolve,
  );
  if (!result.ok) {
    throw new AssimpError(result.code, result.message);
  }
  return { files: result.files };
};
