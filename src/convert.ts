/** Public conversion types plus staged-plan and resolver orchestration. */

import { AssimpError, type AssimpFailureCode } from './assimp-error.js';
import { validatePlanOptions, type NativePlanOptions } from './assimp-options.js';
import type {
  AllExportFormat,
  ExportOptionsFor,
  ImportOptions,
  PostProcessStep,
} from './generated/assimp-capabilities.js';

/** One named input or output payload. @public */
export type AssimpFile = {
  readonly name: string;
  readonly bytes: Uint8Array;
};

/** Load a named sidecar directly or asynchronously. @public */
export type ResolveFile = (name: string) => Uint8Array | undefined | Promise<Uint8Array | undefined>;

/** One canonical export target and its exact target-specific options. @public */
export type ConvertTarget<Format extends AllExportFormat = AllExportFormat> = Format extends AllExportFormat
  ? {
      readonly to: Format;
      readonly exportOptions?: ExportOptionsFor<Format>;
    }
  : never;

/** One positional output slot. @public */
export type ConvertedFormat<Format extends AllExportFormat = AllExportFormat> = {
  readonly format: Format;
  readonly files: readonly AssimpFile[];
};

/** Settings for singular conversion. @public */
export type ConvertOptions<Format extends AllExportFormat = AllExportFormat> = Format extends AllExportFormat
  ? {
      readonly to: Format;
      readonly resolve?: ResolveFile;
      readonly importOptions?: ImportOptions;
      readonly postProcess?: readonly PostProcessStep[];
      readonly exportOptions?: ExportOptionsFor<Format>;
    }
  : never;

/** Settings for one import and an ordered non-empty target tuple. @public */
export type ConvertFormatsOptions<Targets extends readonly [ConvertTarget, ...ConvertTarget[]]> = {
  readonly targets: Targets;
  readonly resolve?: ResolveFile;
  readonly importOptions?: ImportOptions;
  readonly postProcess?: readonly PostProcessStep[];
};

/** Positional target-to-result mapping. @public */
export type ConvertFormatsResult<Targets extends readonly [ConvertTarget, ...ConvertTarget[]]> = {
  readonly [Index in keyof Targets]: Targets[Index] extends ConvertTarget<infer Format>
    ? ConvertedFormat<Format>
    : never;
};

/** Existing singular result shape. @public */
export type ConvertResult = { readonly files: readonly AssimpFile[] };

type NativeResult = Readonly<{
  ok: boolean;
  code: AssimpFailureCode | '';
  message: string;
  formatIndex?: number;
  format?: string;
  formats: readonly ConvertedFormat[];
}>;

/** Embind surface; the raw run export is captured from the Wasm instance. @internal */
export type NativeModule = {
  readonly _libassimp_run_plan: (handle: number) => number;
  readonly preparePlan: (
    entryName: string,
    files: readonly AssimpFile[],
    options: NativePlanOptions,
  ) => number;
  readonly takePlanResult: (handle: number) => NativeResult;
  readonly destroyPlan: (handle: number) => void;
};

type ResolverState =
  | { readonly status: 'missing' }
  | { readonly status: 'ready'; readonly bytes: Uint8Array }
  | { readonly status: 'pending'; readonly promise: Promise<number> };

export type ResolutionDispatch = Readonly<{
  operation: number;
  first: number;
  second: number;
  memory: WebAssembly.Memory;
  suspending: boolean;
}>;

const isPromiseLike = (value: unknown): value is PromiseLike<Uint8Array | undefined> =>
  (typeof value === 'object' || typeof value === 'function') &&
  value !== null &&
  typeof (value as { then?: unknown }).then === 'function';

/** Per-call resolver cache shared by JSPI and replay. @internal */
export class ResolutionContext {
  private readonly states = new Map<string, ResolverState>();
  private readonly handles = new Map<number, Uint8Array>();
  private readonly pendingSinceRun = new Set<Promise<number>>();
  private nextHandle = 1;
  public failure?: { readonly fileName: string; readonly cause: unknown };

  public constructor(private readonly resolve: ResolveFile | undefined) {}

  private settle(name: string, bytes: Uint8Array | undefined): number {
    if (bytes === undefined) {
      this.states.set(name, { status: 'missing' });
      return 0;
    }
    if (!(bytes instanceof Uint8Array)) {
      this.fail(name, new TypeError('resolve must return Uint8Array or undefined.'));
      return -1;
    }
    this.states.set(name, { status: 'ready', bytes });
    return this.allocate(bytes);
  }

  private fail(fileName: string, cause: unknown): void {
    this.failure ??= { fileName, cause };
    this.states.set(fileName, { status: 'missing' });
  }

  private allocate(bytes: Uint8Array): number {
    const handle = this.nextHandle++;
    this.handles.set(handle, bytes);
    return handle;
  }

  private begin(name: string, suspending: boolean): number | Promise<number> {
    const existing = this.states.get(name);
    if (existing?.status === 'ready') return this.allocate(existing.bytes);
    if (existing?.status === 'missing') return 0;
    if (existing?.status === 'pending') {
      return suspending ? existing.promise : -1;
    }
    if (this.resolve === undefined) {
      this.states.set(name, { status: 'missing' });
      return 0;
    }

    let resolved: ReturnType<ResolveFile>;
    try {
      resolved = this.resolve(name);
    } catch (cause) {
      this.fail(name, cause);
      return -1;
    }
    if (!isPromiseLike(resolved)) return this.settle(name, resolved);

    const promise = Promise.resolve(resolved).then(
      (bytes) => this.settle(name, bytes),
      (cause: unknown) => {
        this.fail(name, cause);
        return -1;
      },
    );
    this.states.set(name, { status: 'pending', promise });
    this.pendingSinceRun.add(promise);
    return suspending ? promise : -1;
  }

  public dispatch({
    operation,
    first,
    second,
    memory,
    suspending,
  }: ResolutionDispatch): number | Promise<number> {
    if (operation === 1) {
      const name = new TextDecoder().decode(new Uint8Array(memory.buffer, first, second));
      return this.begin(name, suspending);
    }
    const bytes = this.handles.get(first);
    if (operation === 2) return bytes?.byteLength ?? -1;
    if (operation === 3) {
      if (bytes === undefined) return -1;
      if (bytes.byteLength > 0) new Uint8Array(memory.buffer, second, bytes.byteLength).set(bytes);
      return bytes.byteLength;
    }
    if (operation === 4) {
      this.handles.delete(first);
      return 0;
    }
    return -1;
  }

  public takePending(): readonly Promise<number>[] {
    const pending = [...this.pendingSinceRun];
    this.pendingSinceRun.clear();
    return pending;
  }

  public getFailure(): ResolutionContext['failure'] {
    return this.failure;
  }
}

/** Loaded raw bridge plus one active resolver slot. @internal */
export type NativeRuntime = Readonly<{
  native: NativeModule;
  runPlan: (handle: number, context: ResolutionContext) => Promise<number>;
}>;

/** A validated request that has not copied bytes into Wasm. @internal */
export type PreparedConversion<
  Targets extends readonly [ConvertTarget, ...ConvertTarget[]] = readonly [ConvertTarget, ...ConvertTarget[]],
> = Readonly<{
  files: readonly [AssimpFile, ...AssimpFile[]];
  nativeOptions: NativePlanOptions;
  resolve: ResolveFile | undefined;
  targets: Targets;
}>;

const isAssimpFile = (value: unknown): value is AssimpFile =>
  typeof value === 'object' &&
  value !== null &&
  'name' in value &&
  typeof value.name === 'string' &&
  'bytes' in value &&
  value.bytes instanceof Uint8Array;

const normalizeFiles = (
  files: AssimpFile | readonly AssimpFile[],
): readonly [AssimpFile, ...AssimpFile[]] => {
  const values = (Array.isArray(files) ? files : [files]) as readonly unknown[];
  if (values.length === 0) throw new AssimpError('NO_FILES', 'convert needs at least one input file.');
  for (let index = 0; index < values.length; index += 1) {
    const file = values[index];
    if (!isAssimpFile(file)) {
      throw new AssimpError('INVALID_OPTIONS', `Invalid files:\n- files[${index}]: expected { name, bytes }`);
    }
  }
  return values as unknown as readonly [AssimpFile, ...AssimpFile[]];
};

/** Validate a plural request before it enters the per-instance queue. @internal */
export const prepareConversion = <const Targets extends readonly [ConvertTarget, ...ConvertTarget[]]>(
  files: AssimpFile | readonly AssimpFile[],
  options: ConvertFormatsOptions<Targets>,
  supportedFormats: ReadonlySet<string>,
): PreparedConversion<Targets> => {
  const list = normalizeFiles(files);
  const nativeOptions = validatePlanOptions(options, supportedFormats);
  return { files: list, nativeOptions, resolve: options.resolve, targets: options.targets };
};

const resolverFailure = (failure: NonNullable<ResolutionContext['failure']>): AssimpError =>
  new AssimpError('RESOLVE_FAILED', `Failed to resolve '${failure.fileName}'.`, failure);

/** Execute one already validated staged plan. @internal */
export const runPreparedConversion = async <
  const Targets extends readonly [ConvertTarget, ...ConvertTarget[]],
>(
  runtime: NativeRuntime,
  request: PreparedConversion<Targets>,
): Promise<ConvertFormatsResult<Targets>> => {
  const context = new ResolutionContext(request.resolve);
  const handle = runtime.native.preparePlan(request.files[0].name, request.files, request.nativeOptions);
  try {
    for (;;) {
      const status = await runtime.runPlan(handle, context);
      const failure = context.getFailure();
      if (failure !== undefined) throw resolverFailure(failure);
      if (status !== -1) break;
      const pending = context.takePending();
      if (pending.length === 0) {
        throw new Error('libassimp replay invariant failed: PENDING without new resolver work.');
      }
      await Promise.all(pending);
      const settledFailure = context.getFailure();
      if (settledFailure !== undefined) throw resolverFailure(settledFailure);
    }
    const result = runtime.native.takePlanResult(handle);
    if (!result.ok) {
      throw new AssimpError(result.code as AssimpFailureCode, result.message, {
        ...(result.formatIndex === undefined ? {} : { formatIndex: result.formatIndex }),
        ...(result.format === undefined ? {} : { format: result.format }),
      });
    }
    return result.formats as ConvertFormatsResult<Targets>;
  } finally {
    runtime.native.destroyPlan(handle);
  }
};
