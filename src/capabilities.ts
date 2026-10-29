/**
 * `libassimp/capabilities` — the capability registry with prose descriptions.
 *
 * The root entry's `assimpCapabilities` carries kinds, defaults, ranges and
 * values, which validation and dynamic forms need. This subpath adds a
 * handwritten `description` for help text to each option whose name does not
 * already say what it does, and to every post-process step. It is meant to be
 * loaded lazily with `await import('libassimp/capabilities')`. Importing it
 * never loads Wasm or the native addon.
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

/**
 * Option metadata with its help text. `description` is a plain sentence or
 * two for a person choosing the value, and is absent when the option name
 * already says what it does, such as `binary`. Show the name alone then. @public
 */
export type DescribedOptionDescriptor = OptionDescriptor & Readonly<{ description?: string }>;

/** Post-process step metadata with its prose description. @public */
export type DescribedPostProcessDescriptor = PostProcessDescriptor & Readonly<{ description: string }>;

type Registry = typeof registry;
type DescribedOptions<Descriptors> = {
  readonly [Key in keyof Descriptors]: Descriptors[Key] & Readonly<{ description?: string }>;
};
type DescribedSteps<Descriptors> = {
  readonly [Key in keyof Descriptors]: Descriptors[Key] & Readonly<{ description: string }>;
};

/**
 * The root registry's shape with a `description` on every post-process step
 * and on each option whose name needs one. @public
 */
export type DescribedCapabilities = Readonly<{
  import: Registry['import'];
  export: {
    readonly [Format in keyof Registry['export']]: Omit<Registry['export'][Format], 'exportOptions'> &
      Readonly<{ exportOptions: DescribedOptions<Registry['export'][Format]['exportOptions']> }>;
  };
  importOptions: DescribedOptions<Registry['importOptions']>;
  postProcess: DescribedSteps<Registry['postProcess']>;
}>;

// An option without prose gets no `description` key rather than `undefined`.
const describe = (
  descriptors: Readonly<Record<string, object>>,
  descriptions: Readonly<Record<string, string>>,
): Record<string, object> =>
  Object.fromEntries(
    Object.entries(descriptors).map(([name, descriptor]) => {
      const description = descriptions[name];
      return [name, description === undefined ? { ...descriptor } : { ...descriptor, description }];
    }),
  );

const exportDescriptions: Readonly<Record<string, Readonly<Record<string, string>>>> =
  exportOptionDescriptions;

/** The capability registry with option and step help text. @public */
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
