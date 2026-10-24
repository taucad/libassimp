/**
 * `libassimp/capabilities` — the capability registry with prose descriptions.
 *
 * The root entry's `assimpCapabilities` carries kinds, defaults, ranges and
 * values, which validation and dynamic forms need. This subpath adds each
 * option's and post-process step's `description` for help text and labels, and
 * is meant to be loaded lazily with `await import('libassimp/capabilities')`.
 * Importing it never loads Wasm or the native addon.
 */

import {
  assimpCapabilities as registry,
  type OptionDescriptor,
  type PostProcessDescriptor,
} from './generated/assimp-capabilities.js';
import {
  exportOptionDescriptions,
  importOptionDescriptions,
  postProcessDescriptions,
} from './generated/assimp-capability-descriptions.js';

/** Option metadata with its prose description. @public */
export type DescribedOptionDescriptor = OptionDescriptor & Readonly<{ description: string }>;

/** Post-process step metadata with its prose description. @public */
export type DescribedPostProcessDescriptor = PostProcessDescriptor & Readonly<{ description: string }>;

type Registry = typeof registry;
type Described<Descriptors> = {
  readonly [Key in keyof Descriptors]: Descriptors[Key] & Readonly<{ description: string }>;
};

/** The root registry's shape with a `description` on every option and step. @public */
export type DescribedCapabilities = Readonly<{
  import: Registry['import'];
  export: {
    readonly [Format in keyof Registry['export']]: Omit<Registry['export'][Format], 'exportOptions'> &
      Readonly<{ exportOptions: Described<Registry['export'][Format]['exportOptions']> }>;
  };
  importOptions: Described<Registry['importOptions']>;
  postProcess: Described<Registry['postProcess']>;
}>;

const describe = (
  descriptors: Readonly<Record<string, object>>,
  descriptions: Readonly<Record<string, string>>,
): Record<string, object> =>
  Object.fromEntries(
    Object.entries(descriptors).map(([name, descriptor]) => [
      name,
      // The generator emits a description for every option and step.
      { ...descriptor, description: descriptions[name] as string },
    ]),
  );

const exportDescriptions: Readonly<Record<string, Readonly<Record<string, string>>>> =
  exportOptionDescriptions;

/** The capability registry with option and step descriptions. @public */
export const assimpCapabilities = {
  import: registry.import,
  export: Object.fromEntries(
    Object.entries(registry.export).map(([format, info]) => [
      format,
      {
        ...info,
        exportOptions: describe(info.exportOptions, exportDescriptions[format] as Record<string, string>),
      },
    ]),
  ),
  importOptions: describe(registry.importOptions, importOptionDescriptions),
  postProcess: describe(registry.postProcess, postProcessDescriptions),
} as unknown as DescribedCapabilities;
