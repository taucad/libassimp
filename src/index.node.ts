/** `libassimp` on Node.js — the root API with lazy native selection. */

import { createEntry, loadModule } from './create-assimp.js';
import { exportFormats, importFormats } from './generated/assimp-capabilities.js';
import type { ExportFormat, ImportFormat } from './index.js';
import { createNodeRuntimeLoader } from './native-backend.js';

export * from './index.js';

const glueUrl = new URL('./wasm/libassimp.js', import.meta.url);
const wasmUrl = new URL('./wasm/libassimp.wasm', import.meta.url);
const entry = createEntry<ImportFormat, ExportFormat>(glueUrl, wasmUrl, {
  import: importFormats,
  export: exportFormats,
  loadRuntime: createNodeRuntimeLoader((options) => loadModule(glueUrl, wasmUrl, options)),
});

/** Convert one source to one canonical target. @public */
export const convert = entry.convert;
/** Import once and export an ordered non-empty target tuple. @public */
export const convertFormats = entry.convertFormats;
/** Create a native-or-Wasm conversion instance; native work is process-serialized. @public */
export const createAssimp = entry.createAssimp;
