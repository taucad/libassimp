import { expectTypeOf, test } from 'vitest';

import { canonicalExports } from './formats.test.js';
import {
  assimpCapabilities,
  convertFormats,
  type ConversionEdge,
  type ConvertOptions,
  type ConvertTarget,
  type ConvertedFormat,
  type ExportFormat,
} from './index.js';
import type { ExportFormat as ImporterExportFormat } from './importer.js';
import type {
  ConversionEdge as ExporterConversionEdge,
  ExportFormat as ExporterExportFormat,
} from './exporter.js';

declare const bytes: Uint8Array;

test('entry unions and positional tuple inference remain exact', () => {
  expectTypeOf<ExportFormat>().toEqualTypeOf<(typeof canonicalExports)[number]>();
  expectTypeOf<ExporterExportFormat>().toEqualTypeOf<ExportFormat>();
  expectTypeOf<ImporterExportFormat>().toEqualTypeOf<'assjson' | 'glb' | 'gltf'>();

  const result = convertFormats(
    { name: 'model.obj', bytes },
    { targets: [{ to: 'glb' }, { to: 'stl', exportOptions: { binary: true } }, { to: 'glb' }] },
  );
  expectTypeOf(result).toEqualTypeOf<
    Promise<readonly [ConvertedFormat<'glb'>, ConvertedFormat<'stl'>, ConvertedFormat<'glb'>]>
  >();
});

test('format options are correlated and native escape hatches do not exist', () => {
  expectTypeOf<ConvertOptions<'stl'>>().toExtend<{ exportOptions?: { binary?: boolean } }>();
  expectTypeOf<ConvertOptions<'obj'>>().toExtend<{ exportOptions?: { materials?: boolean } }>();
  expectTypeOf<ConvertOptions<'glb'>>().not.toExtend<{ exportOptions?: { binary?: boolean } }>();
  expectTypeOf<ConvertTarget>().not.toExtend<{ id: string }>();
  expectTypeOf<ConvertedFormat>().not.toExtend<{ id: string }>();
  // @ts-expect-error native keys are absent from public descriptors
  void assimpCapabilities.export.glb.exportOptions.pointClouds.nativeName;
  // @ts-expect-error raw property bags were removed before release
  void ({ to: 'glb', properties: { FAKE: true } } satisfies ConvertOptions<'glb'>);
  // @ts-expect-error glTF binary is a distinct canonical format, not an option
  void ({ to: 'glb', exportOptions: { binary: true } } satisfies ConvertOptions<'glb'>);
  // @ts-expect-error target tuples are statically non-empty
  void convertFormats({ name: 'model.obj', bytes }, { targets: [] });
});

test('edge unions preserve exact source/target correlation', () => {
  expectTypeOf<Extract<ConversionEdge, { from: 'glb'; to: 'glb' }>>().toEqualTypeOf<never>();
  expectTypeOf<Extract<ExporterConversionEdge, { from: 'glb'; to: 'stl' }>>().not.toEqualTypeOf<never>();
  expectTypeOf<Extract<ExporterConversionEdge, { from: 'gltf'; to: 'glb' }>>().not.toEqualTypeOf<never>();
});
