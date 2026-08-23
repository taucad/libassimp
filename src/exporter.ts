/**
 * `libassimp/exporter` — every exporter the engine builds cleanly, reading
 * glTF, GLB, and USD. Import this entry to write a glTF pipeline's output to
 * another format.
 */

import type { ConvertOptions as SharedConvertOptions } from './convert.js';
import { createEntry } from './create-assimp.js';
import type { Assimp as SharedAssimp } from './create-assimp.js';
import type { AllExportFormat } from './formats.js';

export { AssimpError } from './assimp-error.js';
export type { AssimpFailureCode } from './assimp-error.js';
export type { AssimpFile, ConvertResult } from './convert.js';
export type { CreateAssimpOptions } from './create-assimp.js';
export type { FormatInfo } from './formats.js';

/** Export targets this entry accepts. @public */
export type ExportFormat = AllExportFormat;

/** Settings for one conversion through this entry. @public */
export type ConvertOptions = SharedConvertOptions<ExportFormat>;

/** A conversion instance holding this entry's compiled module. @public */
export type Assimp = SharedAssimp<ExportFormat>;

const entry = createEntry<ExportFormat>(
  new URL('./wasm/libassimp-exporter.js', import.meta.url),
  new URL('./wasm/libassimp-exporter.wasm', import.meta.url),
);

/**
 * Convert a glTF, GLB, or USD model to another format. Calls share one lazily
 * loaded module, so the first call pays for loading it.
 *
 * @public
 * @param files - The model, or files whose first element is the entry file.
 * @param options - Target format and per-call settings.
 * @returns The output files, primary output first.
 * @throws AssimpError when the format is unavailable or a conversion phase fails.
 * @example
 * ```typescript
 * import { convert } from 'libassimp/exporter';
 *
 * const { files } = await convert({ name: 'model.glb', bytes }, { to: 'stl' });
 * console.log(files[0].name); // result.stl
 * ```
 */
export const convert = entry.convert;

/**
 * Create a conversion instance whose lifetime you control, with its own binary
 * location and diagnostic sink. Dispose it when the work is done.
 *
 * @public
 * @param options - Binary location and diagnostics.
 * @returns The instance.
 * @example
 * ```typescript
 * import { createAssimp } from 'libassimp/exporter';
 *
 * using assimp = await createAssimp();
 * const { files } = await assimp.convert({ name: 'model.glb', bytes }, { to: '3mf' });
 * ```
 */
export const createAssimp = entry.createAssimp;
