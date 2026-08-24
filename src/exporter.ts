/** `libassimp/exporter` — glTF/USD import with every canonical exporter. */

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
  allExportFormats,
  defaultPostProcess,
  exporterAssimpCapabilities,
  exporterConversionEdges,
  exporterImportFormats,
} from './generated/assimp-capabilities.js';
import type {
  AllExportFormat,
  ConversionEdgeFor,
  ExporterImportFormat,
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

export type ImportFormat = ExporterImportFormat;
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

export const assimpCapabilities = exporterAssimpCapabilities;
export const conversionEdges: readonly ConversionEdge[] = exporterConversionEdges;
export { defaultPostProcess };

const entry = createEntry<ImportFormat, ExportFormat>(
  new URL('./wasm/libassimp-exporter.js', import.meta.url),
  new URL('./wasm/libassimp-exporter.wasm', import.meta.url),
  { import: exporterImportFormats, export: allExportFormats },
);

export const convert = entry.convert;
export const convertFormats = entry.convertFormats;
export const createAssimp = entry.createAssimp;
