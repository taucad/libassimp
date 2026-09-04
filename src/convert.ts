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
      /** Cancels this conversion without changing the resolver's one-argument contract. */
      readonly signal?: AbortSignal;
      readonly importOptions?: ImportOptions;
      readonly postProcess?: readonly PostProcessStep[];
      readonly exportOptions?: ExportOptionsFor<Format>;
    }
  : never;

/** Settings for one import and an ordered non-empty target tuple. @public */
export type ConvertFormatsOptions<Targets extends readonly [ConvertTarget, ...ConvertTarget[]]> = {
  readonly targets: Targets;
  readonly resolve?: ResolveFile;
  /** Cancels this conversion without changing the resolver's one-argument contract. */
  readonly signal?: AbortSignal;
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

/** One terminal resolver answer shared by Wasm and native bridges. @internal */
export type ResolutionResult =
  | { readonly status: 'found'; readonly bytes: Uint8Array }
  | { readonly status: 'missing' }
  | { readonly status: 'failed' }
  | { readonly status: 'aborted' };

type PendingResolution = Promise<ResolutionResult | undefined>;
type ResolverState = ResolutionResult | { readonly status: 'pending'; readonly promise: PendingResolution };

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

const isBytes = (value: unknown): value is Uint8Array =>
  value instanceof Uint8Array && ArrayBuffer.isView(value);

/** Interpret an Emscripten i32 pointer or length as an unsigned Wasm value. @internal */
export const unsignedWasmI32 = (value: number): number => value >>> 0;

/** Per-call resolver cache shared by native, JSPI, and replay. @internal */
export class ResolutionContext {
  private readonly states = new Map<string, ResolverState>();
  private readonly handles = new Map<number, { readonly name: string; readonly bytes: Uint8Array }>();
  private readonly pendingSinceRun = new Set<PendingResolution>();
  private readonly pendingClosers = new Set<(result: ResolutionResult | undefined) => void>();
  private nextHandle = 1;
  private generation = 0;
  private closed = false;
  private disposed = false;
  private aborted = false;
  private abortReason: unknown;
  private cancel: (() => void) | undefined;
  public failure?: { readonly fileName: string; readonly cause: unknown };

  public constructor(
    private resolver: ResolveFile | undefined,
    private readonly signal?: AbortSignal,
  ) {
    if (signal?.aborted) this.abort();
    else signal?.addEventListener('abort', this.abort, { once: true });
  }

  private readonly abort = (): void => {
    this.aborted = true;
    this.abortReason = this.signal?.reason;
    this.close({ status: 'aborted' });
    const cancel = this.cancel;
    this.cancel = undefined;
    cancel?.();
  };

  private close(result: ResolutionResult | undefined): void {
    if (this.closed) return;
    this.closed = true;
    this.generation += 1;
    this.states.clear();
    this.handles.clear();
    this.pendingSinceRun.clear();
    this.resolver = undefined;
    this.signal?.removeEventListener('abort', this.abort);
    const closers = [...this.pendingClosers];
    this.pendingClosers.clear();
    for (const close of closers) close(result);
  }

  private settle(name: string, bytes: Uint8Array | undefined): ResolutionResult {
    if (bytes === undefined) {
      const result = { status: 'missing' } as const;
      this.states.set(name, result);
      return result;
    }
    if (!isBytes(bytes)) {
      this.fail(name, new TypeError('resolve must return Uint8Array or undefined.'));
      return { status: 'failed' };
    }
    const result = { status: 'found', bytes } as const;
    this.states.set(name, result);
    return result;
  }

  private fail(fileName: string, cause: unknown): void {
    this.failure ??= { fileName, cause };
    this.states.set(fileName, { status: 'failed' });
  }

  private allocate(name: string, bytes: Uint8Array): number {
    const handle = this.nextHandle++;
    this.handles.set(handle, { name, bytes });
    return handle;
  }

  /** Forget transferred bytes once the C++ plan owns its copy. @internal */
  public release(name: string): void {
    this.states.delete(name);
  }

  /** Resolve one exact name once without allocating backend-specific resources. @internal */
  public resolve(name: string): ResolutionResult | PendingResolution | undefined {
    if (this.disposed) return undefined;
    if (this.aborted) return { status: 'aborted' };
    const existing = this.states.get(name);
    if (existing !== undefined) return existing.status === 'pending' ? existing.promise : existing;
    if (this.resolver === undefined) return this.settle(name, undefined);

    const generation = this.generation;
    let resolved: ReturnType<ResolveFile>;
    let asynchronous: boolean;
    try {
      resolved = this.resolver(name);
      asynchronous = isPromiseLike(resolved);
    } catch (cause) {
      if (generation !== this.generation) return this.currentResult(undefined);
      this.fail(name, cause);
      return { status: 'failed' };
    }
    if (generation !== this.generation) {
      void Promise.resolve(resolved).catch(() => undefined);
      return this.currentResult(undefined);
    }
    if (!asynchronous) return this.settle(name, resolved as Uint8Array | undefined);

    let finish!: (result: ResolutionResult | undefined) => void;
    const promise = new Promise<ResolutionResult | undefined>((resolve) => {
      finish = resolve;
    });
    const complete = (result: ResolutionResult | undefined): void => {
      this.pendingClosers.delete(complete);
      finish(result);
    };
    this.pendingClosers.add(complete);
    void Promise.resolve(resolved).then(
      (bytes) => {
        if (generation !== this.generation) return;
        complete(this.settle(name, bytes));
      },
      (cause: unknown) => {
        if (generation !== this.generation) return;
        this.fail(name, cause);
        complete({ status: 'failed' });
      },
    );
    this.states.set(name, { status: 'pending', promise });
    return promise;
  }

  private wasmResult(name: string, result: ResolutionResult | undefined): number {
    result = this.currentResult(result);
    if (result === undefined || result.status === 'failed' || result.status === 'aborted') return -1;
    if (result.status === 'missing') return 0;
    return this.allocate(name, result.bytes);
  }

  public dispatch({
    operation,
    first,
    second,
    memory,
    suspending,
  }: ResolutionDispatch): number | Promise<number> {
    first = unsignedWasmI32(first);
    second = unsignedWasmI32(second);
    if (operation === 1) {
      const name = new TextDecoder().decode(new Uint8Array(memory.buffer, first, second));
      const resolution = this.resolve(name);
      if (!(resolution instanceof Promise)) return this.wasmResult(name, resolution);
      if (suspending) return resolution.then((result) => this.wasmResult(name, result));
      this.pendingSinceRun.add(resolution);
      return -1;
    }
    const transfer = this.handles.get(first);
    const bytes = transfer?.bytes;
    if (operation === 2) return bytes?.byteLength ?? -1;
    if (operation === 3) {
      if (bytes === undefined) return -1;
      if (bytes.byteLength > 0) new Uint8Array(memory.buffer, second, bytes.byteLength).set(bytes);
      return bytes.byteLength;
    }
    if (operation === 4) {
      if (transfer !== undefined) this.release(transfer.name);
      this.handles.delete(first);
      return 0;
    }
    return -1;
  }

  public takePending(): readonly PendingResolution[] {
    const pending = [...this.pendingSinceRun];
    this.pendingSinceRun.clear();
    return pending;
  }

  /** Fence a queued consumer against abort or disposal after Promise settlement. @internal */
  public currentResult(result: ResolutionResult | undefined): ResolutionResult | undefined {
    if (this.disposed) return undefined;
    if (this.aborted) return { status: 'aborted' };
    return result;
  }

  /** Bind cancellation after a plan exists, including an abort during preparation. @internal */
  public setCancel(cancel: () => void): void {
    if (this.aborted) cancel();
    else this.cancel = cancel;
  }

  /** Throw the signal's exact reason after an asynchronous boundary. @internal */
  public throwIfAborted(): void {
    if (this.aborted) throw this.abortReason;
  }

  /** Close this call and fence every late resolver settlement. @internal */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel = undefined;
    this.close(undefined);
  }

  public getFailure(): ResolutionContext['failure'] {
    return this.failure;
  }
}

/** Backend-neutral staged-plan bridge used by the public facade. @internal */
export type NativeRuntime = Readonly<{
  backend: 'native' | 'wasm';
  buildIdentity?: string;
  preparePlan: (entryName: string, files: readonly AssimpFile[], options: NativePlanOptions) => unknown;
  runPlan: (handle: unknown, context: ResolutionContext) => Promise<number>;
  cancelPlan: (handle: unknown) => void;
  takePlanResult: (handle: unknown) => NativeResult;
  destroyPlan: (handle: unknown) => void;
  dispose: () => void;
}>;

/** A validated request that has not copied bytes into Wasm. @internal */
export type PreparedConversion<
  Targets extends readonly [ConvertTarget, ...ConvertTarget[]] = readonly [ConvertTarget, ...ConvertTarget[]],
> = Readonly<{
  files: readonly [AssimpFile, ...AssimpFile[]];
  nativeOptions: NativePlanOptions;
  resolve: ResolveFile | undefined;
  signal: AbortSignal | undefined;
  targets: Targets;
}>;

const isAssimpFile = (value: unknown): value is AssimpFile =>
  typeof value === 'object' &&
  value !== null &&
  'name' in value &&
  typeof value.name === 'string' &&
  'bytes' in value &&
  isBytes(value.bytes);

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
  if (options.signal?.aborted) throw options.signal.reason;
  const list = normalizeFiles(files);
  const nativeOptions = validatePlanOptions(options, supportedFormats);
  return {
    files: list,
    nativeOptions,
    resolve: options.resolve,
    signal: options.signal,
    targets: options.targets,
  };
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
  const context = new ResolutionContext(request.resolve, request.signal);
  let handle: unknown;
  let prepared = false;
  try {
    context.throwIfAborted();
    handle = runtime.preparePlan(request.files[0].name, request.files, request.nativeOptions);
    prepared = true;
    context.setCancel(() => {
      runtime.cancelPlan(handle);
    });
    context.throwIfAborted();
    for (;;) {
      let status: number;
      try {
        status = await runtime.runPlan(handle, context);
      } catch (error) {
        context.throwIfAborted();
        throw error;
      }
      context.throwIfAborted();
      const failure = context.getFailure();
      if (failure !== undefined) throw resolverFailure(failure);
      if (status !== -1) break;
      const pending = context.takePending();
      if (pending.length === 0) {
        throw new Error('libassimp replay invariant failed: PENDING without new resolver work.');
      }
      await Promise.all(pending);
      context.throwIfAborted();
      const settledFailure = context.getFailure();
      if (settledFailure !== undefined) throw resolverFailure(settledFailure);
    }
    const result = runtime.takePlanResult(handle);
    if (!result.ok) {
      throw new AssimpError(result.code as AssimpFailureCode, result.message, {
        ...(result.formatIndex === undefined ? {} : { formatIndex: result.formatIndex }),
        ...(result.format === undefined ? {} : { format: result.format }),
      });
    }
    return result.formats as ConvertFormatsResult<Targets>;
  } finally {
    context.dispose();
    if (prepared) runtime.destroyPlan(handle);
  }
};
