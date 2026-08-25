/** `libassimp` — the canonical importer/exporter build. */

import type {
  ConvertFormatsOptions as SharedConvertFormatsOptions,
  ConvertFormatsResult as SharedConvertFormatsResult,
  ConvertOptions as SharedConvertOptions,
  ConvertTarget as SharedConvertTarget,
  ConvertedFormat as SharedConvertedFormat,
} from './convert.js';
import { createEntry } from './create-assimp.js';
import type { Assimp as SharedAssimp } from './create-assimp.js';
import {
  assimpCapabilities,
  conversionEdges,
  defaultPostProcess,
  exportFormats,
  importFormats,
} from './generated/assimp-capabilities.js';
import type {
  AllExportFormat,
  CompiledImportFormat,
  ConversionEdgeFor,
  ExportFormatInfo as SharedExportFormatInfo,
  ImportFormatInfo as SharedImportFormatInfo,
} from './generated/assimp-capabilities.js';

export { AssimpError } from './assimp-error.js';
export type { AssimpErrorContext, AssimpFailureCode } from './assimp-error.js';
export type { AssimpFile, ConvertResult, ResolveFile } from './convert.js';
export type { CreateAssimpOptions } from './create-assimp.js';
export type {
  ExportOptionDescriptorsFor,
  ExportOptionsByFormat,
  ExportOptionsFor,
  FormatInfo,
  ImportOptions,
  OptionDescriptor,
  PostProcessDescriptor,
  PostProcessStep,
} from './generated/assimp-capabilities.js';

export type ImportFormat = CompiledImportFormat;
export type ExportFormat = AllExportFormat;
export type ImportFormatInfo<Format extends ImportFormat = ImportFormat> = SharedImportFormatInfo<Format>;
export type ExportFormatInfo<Format extends ExportFormat = ExportFormat> = SharedExportFormatInfo<Format>;
export type ConversionEdge = ConversionEdgeFor<ImportFormat, ExportFormat>;
export type ConvertTarget<Format extends ExportFormat = ExportFormat> = SharedConvertTarget<Format>;
export type ConvertedFormat<Format extends ExportFormat = ExportFormat> = SharedConvertedFormat<Format>;
export type ConvertOptions<Format extends ExportFormat = ExportFormat> = SharedConvertOptions<Format>;
export type ConvertFormatsOptions<Targets extends readonly [ConvertTarget, ...ConvertTarget[]]> =
  SharedConvertFormatsOptions<Targets>;
export type ConvertFormatsResult<Targets extends readonly [ConvertTarget, ...ConvertTarget[]]> =
  SharedConvertFormatsResult<Targets>;
export type Assimp = SharedAssimp<ImportFormat, ExportFormat>;

/** Static generated capabilities; importing this value never loads Wasm. @public */
export { assimpCapabilities };
/** Exact canonical import/export cross-product without identity pairs. @public */
export { conversionEdges };
export { defaultPostProcess };

const entry = createEntry<ImportFormat, ExportFormat>(
  new URL('./wasm/libassimp.js', import.meta.url),
  new URL('./wasm/libassimp.wasm', import.meta.url),
  { import: importFormats, export: exportFormats },
);

/** Convert one source to one canonical target. @public */
export const convert = entry.convert;
/** Import once and export an ordered non-empty target tuple. @public */
export const convertFormats = entry.convertFormats;
/** Create an independently queued conversion instance. @public */
export const createAssimp = entry.createAssimp;
