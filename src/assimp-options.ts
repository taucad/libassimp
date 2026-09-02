/**
 * Runtime validation and the only public-to-native option mapping boundary.
 */

import { AssimpError } from './assimp-error.js';
import {
  defaultPostProcess,
  internalCanonicalExportRoutes,
  internalExportOptionDescriptors,
  internalImportOptionDescriptors,
  internalPostProcessDescriptors,
  type AllExportFormat,
  type ImportOptions,
  type PostProcessStep,
} from './generated/assimp-capabilities.js';

type NativePropertyKind = 'boolean' | 'integer' | 'number' | 'string' | 'matrix';
type NativePropertyValue = boolean | number | string | readonly number[];

/** One validated property assignment copied into the native plan. @internal */
type NativeProperty = Readonly<{
  name: string;
  kind: NativePropertyKind;
  value: NativePropertyValue;
}>;

/** One validated canonical target copied into the native plan. @internal */
type NativeTarget = Readonly<{
  format: AllExportFormat;
  nativeId: string;
  properties: readonly NativeProperty[];
}>;

/** Fully validated native configuration. @internal */
export type NativePlanOptions = Readonly<{
  importProperties: readonly NativeProperty[];
  postProcess: number;
  targets: readonly NativeTarget[];
}>;

type InternalDescriptor = Readonly<{
  nativeName: string;
  kind: NativePropertyKind;
  nativeKind: NativePropertyKind;
  default: boolean | number | string | readonly number[] | null;
  minimum?: number;
  maximum?: number;
  values?: readonly (boolean | number | string)[];
  nativeValues?: Readonly<Record<string, boolean | number | string>>;
  applyDefault?: boolean;
}>;

type InternalRoute = Readonly<{
  nativeId: string;
  routes?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}>;

const importDescriptors = internalImportOptionDescriptors as unknown as Readonly<
  Record<string, InternalDescriptor>
>;
const exportDescriptors = internalExportOptionDescriptors as unknown as Readonly<
  Record<AllExportFormat, Readonly<Record<string, InternalDescriptor>>>
>;
const routes = internalCanonicalExportRoutes as unknown as readonly (InternalRoute & {
  readonly id: AllExportFormat;
})[];
const routesByFormat = Object.fromEntries(routes.map((route) => [route.id, route])) as unknown as Readonly<
  Record<AllExportFormat, InternalRoute>
>;
const steps = internalPostProcessDescriptors as unknown as Readonly<
  Record<PostProcessStep, Readonly<{ value: number; conflicts: readonly PostProcessStep[] }>>
>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const maxFloat32 = 3.402_823_466_385_288_6e38;

type ValueValidation = Readonly<{
  path: string;
  value: unknown;
  descriptor: InternalDescriptor;
  errors: string[];
}>;

const validateValue = ({ path, value, descriptor, errors }: ValueValidation): boolean => {
  if (descriptor.kind === 'boolean' && typeof value !== 'boolean') {
    errors.push(`${path}: expected boolean`);
    return false;
  }
  if (descriptor.kind === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      errors.push(`${path}: expected integer`);
      return false;
    }
    if (value < -2_147_483_648 || value > 2_147_483_647) {
      errors.push(`${path}: expected signed 32-bit integer`);
      return false;
    }
  }
  if (descriptor.kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`${path}: expected finite number`);
      return false;
    }
    if (Math.abs(value) > maxFloat32) {
      errors.push(`${path}: expected finite float32 number`);
      return false;
    }
  }
  if (descriptor.kind === 'string' && typeof value !== 'string') {
    errors.push(`${path}: expected string`);
    return false;
  }
  if (descriptor.kind === 'matrix') {
    if (
      !Array.isArray(value) ||
      value.length !== 16 ||
      !value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
    ) {
      errors.push(`${path}: expected 16 finite numbers`);
      return false;
    }
    if ((value as number[]).some((entry) => Math.abs(entry) > maxFloat32)) {
      errors.push(`${path}: expected 16 finite float32 numbers`);
      return false;
    }
  }
  if (typeof value === 'number' && descriptor.minimum !== undefined && value < descriptor.minimum) {
    errors.push(`${path}: expected at least ${descriptor.minimum}`);
    return false;
  }
  if (typeof value === 'number' && descriptor.maximum !== undefined && value > descriptor.maximum) {
    errors.push(`${path}: expected at most ${descriptor.maximum}`);
    return false;
  }
  if (descriptor.values !== undefined && !descriptor.values.includes(value as never)) {
    errors.push(`${path}: expected one of ${descriptor.values.map(String).join(', ')}`);
    return false;
  }
  return true;
};

type PropertyValidation = Readonly<{
  path: string;
  value: unknown;
  descriptors: Readonly<Record<string, InternalDescriptor>>;
  errors: string[];
}>;

const validateProperties = ({
  path,
  value,
  descriptors,
  errors,
}: PropertyValidation): Record<string, NativePropertyValue> => {
  if (value === undefined) return {};
  if (!isObject(value)) {
    errors.push(`${path}: expected object`);
    return {};
  }
  const valid: Record<string, NativePropertyValue> = {};
  for (const name of Object.keys(value).sort()) {
    const descriptor = descriptors[name];
    if (descriptor === undefined) {
      errors.push(`${path}.${name}: unknown or inapplicable option`);
      continue;
    }
    const candidate = value[name];
    if (validateValue({ path: `${path}.${name}`, value: candidate, descriptor, errors })) {
      valid[name] = candidate as NativePropertyValue;
    }
  }
  return valid;
};

const nativeProperties = (
  values: Readonly<Record<string, NativePropertyValue>>,
  descriptors: Readonly<Record<string, InternalDescriptor>>,
): readonly NativeProperty[] =>
  [
    ...new Set([
      ...Object.keys(values),
      ...Object.entries(descriptors).flatMap(([name, descriptor]) =>
        descriptor.applyDefault && descriptor.default !== null ? [name] : [],
      ),
    ]),
  ]
    .sort()
    .filter((publicName) => !(descriptors[publicName] as InternalDescriptor).nativeName.startsWith('@route/'))
    .map((publicName) => {
      const descriptor = descriptors[publicName] as InternalDescriptor;
      const publicValue = (values[publicName] ?? descriptor.default) as NativePropertyValue;
      const mapped =
        descriptor.nativeValues === undefined || typeof publicValue !== 'string'
          ? publicValue
          : (descriptor.nativeValues[publicValue] as NativePropertyValue);
      const value =
        descriptor.nativeKind === 'integer' && typeof mapped === 'boolean' ? Number(mapped) : mapped;
      return { name: descriptor.nativeName, kind: descriptor.nativeKind, value };
    });

const validatePostProcess = (value: unknown, errors: string[]): number => {
  const candidates = value === undefined ? defaultPostProcess : value;
  if (!Array.isArray(candidates)) {
    errors.push('postProcess: expected array');
    return 0;
  }
  const names = candidates as readonly unknown[];
  const selected = new Set<PostProcessStep>();
  let flags = 0;
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    if (typeof name !== 'string' || !Object.hasOwn(steps, name)) {
      errors.push(`postProcess[${index}]: unknown step ${String(name)}`);
      continue;
    }
    const step = name as PostProcessStep;
    if (selected.has(step)) {
      errors.push(`postProcess[${index}]: duplicate step ${step}`);
      continue;
    }
    for (const conflict of steps[step].conflicts) {
      if (selected.has(conflict)) errors.push(`postProcess: ${step} conflicts with ${conflict}`);
    }
    selected.add(step);
    flags = (flags | steps[step].value) >>> 0;
  }
  return flags;
};

const resolveRoute = (
  format: AllExportFormat,
  values: Readonly<Record<string, NativePropertyValue>>,
): string => {
  const route = routesByFormat[format];
  let nativeId = route.nativeId;
  for (const [option, choices] of Object.entries(route.routes ?? {})) {
    const value = values[option] ?? exportDescriptors[format][option]?.default;
    nativeId = choices[String(value)] as string;
  }
  return nativeId;
};

/** Validate the entire request before the native plan copies or imports files. @internal */
export const validatePlanOptions = (
  options: {
    readonly targets?: unknown;
    readonly importOptions?: unknown;
    readonly postProcess?: unknown;
  },
  supportedFormats: ReadonlySet<string>,
): NativePlanOptions => {
  const errors: string[] = [];
  const imported = validateProperties({
    path: 'importOptions',
    value: options.importOptions,
    descriptors: importDescriptors,
    errors,
  });
  const postProcess = validatePostProcess(options.postProcess, errors);
  const nativeTargets: NativeTarget[] = [];
  let unsupported: { readonly formatIndex: number; readonly format: string } | undefined;
  if (!Array.isArray(options.targets) || options.targets.length === 0) {
    errors.push('targets: expected a non-empty array');
  } else {
    const targets = options.targets as readonly unknown[];
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      if (!isObject(target)) {
        errors.push(`targets[${index}]: expected object`);
        continue;
      }
      const format = target.to;
      if (typeof format !== 'string' || !supportedFormats.has(format)) {
        unsupported ??= { formatIndex: index, format: String(format) };
        continue;
      }
      const canonical = format as AllExportFormat;
      const descriptors = exportDescriptors[canonical];
      const exported = validateProperties({
        path: `targets[${index}].exportOptions`,
        value: target.exportOptions,
        descriptors,
        errors,
      });
      nativeTargets.push({
        format: canonical,
        nativeId: resolveRoute(canonical, exported),
        properties: nativeProperties(exported, descriptors),
      });
    }
  }
  if (unsupported !== undefined) {
    throw new AssimpError(
      'UNSUPPORTED_FORMAT',
      `Unsupported export format '${unsupported.format}'.`,
      unsupported,
    );
  }
  if (errors.length > 0)
    throw new AssimpError('INVALID_OPTIONS', `Invalid options:\n- ${errors.join('\n- ')}`);
  return {
    importProperties: nativeProperties(imported, importDescriptors),
    postProcess,
    targets: nativeTargets,
  };
};

/** Public import option type is re-exported here for handwritten consumers. @public */
export type { ImportOptions };
