import { expectTypeOf, test } from 'vitest';

import type { AllExportFormat, GltfExportFormat } from './formats.js';
import { allExportFormats, gltfExportFormats } from './formats.test.js';
import type { ConvertOptions as RootOptions, ExportFormat as RootFormat } from './index.js';
import type { ConvertOptions as ImporterOptions, ExportFormat as ImporterFormat } from './importer.js';
import type { ExportFormat as ExporterFormat } from './exporter.js';

test('each union holds exactly the ids its runtime test asserts', () => {
  expectTypeOf<AllExportFormat>().toEqualTypeOf<(typeof allExportFormats)[number]>();
  expectTypeOf<GltfExportFormat>().toEqualTypeOf<(typeof gltfExportFormats)[number]>();
});

test('each entry narrows its target ids to what it compiled', () => {
  expectTypeOf<RootFormat>().toEqualTypeOf<AllExportFormat>();
  expectTypeOf<ExporterFormat>().toEqualTypeOf<AllExportFormat>();
  expectTypeOf<ImporterFormat>().toEqualTypeOf<GltfExportFormat>();
  expectTypeOf<RootOptions['to']>().toEqualTypeOf<AllExportFormat>();
  expectTypeOf<ImporterOptions['to']>().toEqualTypeOf<GltfExportFormat>();
  expectTypeOf<ImporterOptions>().not.toExtend<{ to: 'stl' }>();
});
