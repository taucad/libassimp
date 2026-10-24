/** Public conversion types plus staged-plan and resolver orchestration. */

import { AssimpError, type AssimpFailureCode } from './assimp-error.js';
import { validatePlanOptions, type NativePlanOptions } from './assimp-options.js';
import type {
  AllExportFormat,
  ExportOptionsFor,
  ImportOptions,
  PostProcessStep,
} from './generated/assimp-capabilities.js';

/** One named input payload. Keep input bytes unchanged until conversion settles. @public */
export type AssimpFile = {
  readonly name: string;
  readonly bytes: Uint8Array;
};

/**
 * One named output payload. Each output owns its own exact-length,
 * non-shared `ArrayBuffer`, so it can be transferred to a worker or handed to
 * APIs that require `Uint8Array<ArrayBuffer>` without a copy. On hosts with
 * resizable `ArrayBuffer`s the Wasm backend grows the buffer in place while
 * the exporter writes, so `bytes.buffer.resizable` may be `true`.
 *
 * @public
 */
export type ConvertedFile = {
  readonly name: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
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

/**
 * One positional output slot. The primary file comes first and is named after
 * the entry file's stem with the target's canonical extension (`chair.obj`
 * converted to `step` gives `chair.step`); sidecars follow in write order.
 *
 * @public
 */
export type ConvertedFormat<Format extends AllExportFormat = AllExportFormat> = {
  readonly format: Format;
  readonly files: readonly ConvertedFile[];
};

/** Conversion phase named by progress reports and warnings. @public */
export type ConversionPhase = 'import' | 'postProcess' | 'export';

/**
 * One progress report.
 *
 * - `import`: `step` and `total` count bytes of the entry file. assimp reports
 *   `0` when the importer starts and `total` when it finishes; the OBJ importer
 *   also reports while it parses. A non-JSPI Wasm host may restart an import
 *   after a sidecar resolves, so import progress can start again from `0`.
 * - `postProcess`: `step` of `total` registered post-processing stages has
 *   run; stages that are not requested pass instantly.
 * - `export`: `step` of assimp's four export stages for the target at
 *   `formatIndex` (copy, verbose format, post-processing, write).
 *
 * Reports between the start and end of a phase are throttled to one per 50
 * milliseconds.
 *
 * @public
 */
export type ConvertProgress = {
  readonly phase: ConversionPhase;
  readonly step: number;
  readonly total: number;
  /** Zero-based target position, present for `export` reports only. */
  readonly formatIndex?: number;
  /** Canonical target format, present for `export` reports only. */
  readonly format?: AllExportFormat;
};

/** Receives {@link ConvertProgress} reports; a throwing listener never fails the conversion. @public */
export type ConvertProgressListener = (progress: ConvertProgress) => void;

/**
 * A message assimp logged at warning or error severity during a conversion
 * that still succeeded, for example a missing texture or a skipped element.
 * At most 64 are kept; a final entry counts the rest.
 *
 * @public
 */
export type ConversionWarning = {
  readonly severity: 'warning' | 'error';
  readonly phase: ConversionPhase;
  readonly message: string;
  /** Zero-based target position, present for `export` warnings only. */
  readonly formatIndex?: number;
  /** Canonical target format, present for `export` warnings only. */
  readonly format?: AllExportFormat;
};

/**
 * Wall time per phase of a conversion. Milliseconds. `import`, `postProcess`
 * and `export` cover the final engine attempt (`export` sums every target);
 * `total` spans the whole call from the moment it leaves the instance queue,
 * including sidecar resolution, replays, and output handover.
 *
 * @public
 */
export type ConversionTimings = {
  readonly import: number;
  readonly postProcess: number;
  readonly export: number;
  readonly total: number;
};

/**
 * Diagnostics returned with every successful conversion.
 *
 * `peakMemoryBytes` is a high-water mark, not a per-call delta. Wasm: the
 * instance's linear-memory size after the conversion; linear memory never
 * shrinks, so it is the largest heap any conversion on that runtime needed.
 * Native: the Node.js process's peak resident set size
 * (`process.resourceUsage().maxRSS`, in bytes).
 *
 * @public
 */
export type ConversionReport = {
  readonly warnings: readonly ConversionWarning[];
  readonly timings: ConversionTimings;
  readonly peakMemoryBytes: number;
};

/** Settings for singular conversion. @public */
export type ConvertOptions<Format extends AllExportFormat = AllExportFormat> = Format extends AllExportFormat
  ? {
      readonly to: Format;
      readonly resolve?: ResolveFile;
      /** Cancels this conversion without changing the resolver's one-argument contract. */
      readonly signal?: AbortSignal;
      /** Receives throttled progress while the engine runs. */
      readonly onProgress?: ConvertProgressListener;
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
  /** Receives throttled progress while the engine runs. */
  readonly onProgress?: ConvertProgressListener;
  readonly importOptions?: ImportOptions;
  readonly postProcess?: readonly PostProcessStep[];
};

/**
 * Positional target-to-result mapping. The tuple also carries the
 * {@link ConversionReport} fields (`warnings`, `timings`, `peakMemoryBytes`)
 * as own properties.
 *
 * @public
 */
export type ConvertFormatsResult<Targets extends readonly [ConvertTarget, ...ConvertTarget[]]> = {
  readonly [Index in keyof Targets]: Targets[Index] extends ConvertTarget<infer Format>
    ? ConvertedFormat<Format>
    : never;
} & ConversionReport;

/** Singular result: the target's files plus the {@link ConversionReport}. @public */
export type ConvertResult = { readonly files: readonly ConvertedFile[] } & ConversionReport;

/** One output as the engine reports it: bytes (native) or a streamed host file (Wasm). @internal */
type PlanFile = Readonly<{
  name: string;
  bytes?: Uint8Array<ArrayBuffer>;
  hostFile?: number;
  size?: number;
}>;

/** One engine progress report; `phase` is the engine's import, post-process or export ordinal. @internal */
export type EngineProgress = Readonly<{ phase: number; step: number; total: number; formatIndex: number }>;

/** One engine warning; `phase` is the engine's import, post-process or export ordinal. @internal */
type PlanWarning = Readonly<{ error: boolean; phase: number; formatIndex: number; message: string }>;

/** The engine's result, shared by the Wasm and native bindings. @internal */
type PlanResult = Readonly<{
  ok: boolean;
  code: AssimpFailureCode | '';
  message: string;
  formatIndex?: number;
  format?: string;
  formats: readonly Readonly<{ format: string; files: readonly PlanFile[] }>[];
  warnings?: readonly PlanWarning[];
  timings?: Readonly<{ import: number; postProcess: number; export: number }>;
}>;

/** Embind surface; the raw run export is captured from the Wasm instance. @internal */
export type WasmModule = {
  readonly _libassimp_run_plan: (handle: number) => number;
  readonly preparePlan: (
    entryName: string,
    files: readonly AssimpFile[],
    options: NativePlanOptions & { readonly releaseEntry: boolean },
  ) => number;
  readonly takePlanResult: (handle: number) => PlanResult;
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

const progressPhases = [undefined, 'import', 'postProcess', 'export'] as const;

/** Initial reservation of a resizable output buffer; larger outputs move once to a 4 GiB one. */
const initialOutputReservation = 256 * 1024 * 1024;
const maximumOutputBytes = 4 * 1024 * 1024 * 1024;

const resizableBuffer = (maxByteLength: number): ArrayBuffer | undefined => {
  try {
    const buffer = new ArrayBuffer(0, { maxByteLength });
    return buffer.resizable ? buffer : undefined;
  } catch {
    return undefined;
  }
};

/**
 * One streamed Wasm output, assembled on the host. A resizable buffer grows in
 * place, so the finished output is a view of it and is never joined or copied;
 * hosts without resizable buffers grow geometrically and copy once at the end.
 * @internal
 */
export class HostOutput {
  private buffer: ArrayBuffer;

  public constructor(reservation = initialOutputReservation) {
    this.buffer = resizableBuffer(reservation) ?? new ArrayBuffer(0);
  }

  /** Copy `bytes` to `offset`, growing the buffer first when needed. */
  public write(offset: number, bytes: Uint8Array): void {
    this.grow(offset + bytes.byteLength);
    new Uint8Array(this.buffer, offset, bytes.byteLength).set(bytes);
  }

  /** The finished output: exactly `size` bytes, zero-filled past the last write. */
  public take(size: number): Uint8Array<ArrayBuffer> {
    this.grow(size);
    if (this.buffer.resizable) {
      this.buffer.resize(size);
      return new Uint8Array(this.buffer, 0, size);
    }
    return new Uint8Array(this.buffer.byteLength === size ? this.buffer : this.buffer.slice(0, size));
  }

  private grow(end: number): void {
    const current = this.buffer.byteLength;
    if (end <= current) return;
    if (this.buffer.resizable && end <= this.buffer.maxByteLength) {
      this.buffer.resize(end);
      return;
    }
    const next =
      (this.buffer.resizable ? resizableBuffer(maximumOutputBytes) : undefined) ??
      new ArrayBuffer(Math.max(end, current * 2));
    if (next.resizable) next.resize(end);
    new Uint8Array(next).set(new Uint8Array(this.buffer));
    this.buffer = next;
  }
}

/** Per-call options the context needs beyond the resolver and signal. @internal */
export type ResolutionContextOptions = Readonly<{
  onProgress?: ConvertProgressListener | undefined;
  /** Canonical target formats, by position, for progress reports. */
  formats: readonly AllExportFormat[];
}>;

/** Per-call host state shared by native, JSPI, and replay: resolver cache, outputs, progress. @internal */
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
  private failure: { readonly fileName: string; readonly cause: unknown } | undefined;
  private readonly outputs = new Map<number, HostOutput>();
  private outputFailure: unknown;
  private hasOutputFailure = false;

  public constructor(
    private resolver: ResolveFile | undefined,
    private readonly signal?: AbortSignal,
    private readonly options: ResolutionContextOptions = { formats: [] },
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
    if (operation === 5) {
      const [file = 0, data = 0, size = 0, offset = 0] = new Uint32Array(memory.buffer, first, 4);
      return this.writeOutput(file, offset, new Uint8Array(memory.buffer, data, size));
    }
    if (operation === 6) {
      const [phase = 0, step = 0, total = 0, formatIndex = -1] = new Int32Array(memory.buffer, first, 4);
      this.reportProgress({ phase, step, total, formatIndex });
      return 0;
    }
    return -1;
  }

  /** Append or patch a streamed Wasm output; -1 tells the engine the host could not hold it. @internal */
  public writeOutput(file: number, offset: number, bytes: Uint8Array): number {
    let output = this.outputs.get(file);
    if (output === undefined) {
      output = new HostOutput();
      this.outputs.set(file, output);
    }
    try {
      output.write(offset, bytes);
      return 0;
    } catch (error) {
      if (!this.hasOutputFailure) {
        this.hasOutputFailure = true;
        this.outputFailure = error;
      }
      return -1;
    }
  }

  /** A replayed run rewrites every output from the start. @internal */
  public resetOutputs(): void {
    this.outputs.clear();
  }

  /** Hand over a finished streamed output, releasing the host's reference. @internal */
  public takeOutput(file: number, size: number): Uint8Array<ArrayBuffer> {
    const output = this.outputs.get(file) ?? new HostOutput(0);
    this.outputs.delete(file);
    return output.take(size);
  }

  /** The first error the host hit while holding streamed output. @internal */
  public getOutputFailure(): { readonly cause: unknown } | undefined {
    return this.hasOutputFailure ? { cause: this.outputFailure } : undefined;
  }

  /** Whether this call has a progress listener. @internal */
  public reportsProgress(): boolean {
    return this.options.onProgress !== undefined;
  }

  /** Deliver one engine progress report. @internal */
  public reportProgress({ phase, step, total, formatIndex }: EngineProgress): void {
    const listener = this.options.onProgress;
    if (listener === undefined || this.disposed) return;
    const name = progressPhases[phase] as ConversionPhase;
    const progress: ConvertProgress =
      name === 'export'
        ? {
            phase: name,
            step,
            total,
            formatIndex,
            format: this.options.formats[formatIndex] as AllExportFormat,
          }
        : { phase: name, step, total };
    try {
      listener(progress);
    } catch {
      // Progress is advisory; a throwing listener never fails the conversion.
    }
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
    this.outputs.clear();
    this.close(undefined);
  }

  /** The first resolver failure of this call. @internal */
  public getFailure(): { readonly fileName: string; readonly cause: unknown } | undefined {
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
  takePlanResult: (handle: unknown) => PlanResult;
  destroyPlan: (handle: unknown) => void;
  dispose: () => void;
  /** Current Wasm linear-memory size; the high-water mark, since it never shrinks. */
  memoryBytes?: () => number;
  /** The figure reported as {@link ConversionReport.peakMemoryBytes}. */
  peakMemoryBytes: () => number;
}>;

/** A validated request that has not copied bytes into Wasm. @internal */
export type PreparedConversion<
  Targets extends readonly [ConvertTarget, ...ConvertTarget[]] = readonly [ConvertTarget, ...ConvertTarget[]],
> = Readonly<{
  files: readonly [AssimpFile, ...AssimpFile[]];
  nativeOptions: NativePlanOptions;
  resolve: ResolveFile | undefined;
  signal: AbortSignal | undefined;
  onProgress: ConvertProgressListener | undefined;
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
  const errors: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const file = values[index];
    if (!isAssimpFile(file)) {
      errors.push(`files[${index}]: expected { name, bytes }`);
    } else if (file.name === '') {
      errors.push(`files[${index}].name: expected a non-empty name`);
    } else if (seen.has(file.name)) {
      errors.push(
        `files[${index}].name: '${file.name}' repeats an earlier file; every input name must be unique`,
      );
    } else {
      seen.add(file.name);
    }
  }
  if (errors.length > 0) throw new AssimpError('INVALID_OPTIONS', `Invalid files:\n- ${errors.join('\n- ')}`);
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
  const nativeOptions = validatePlanOptions(options, supportedFormats, list[0].name);
  return {
    files: list,
    nativeOptions,
    resolve: options.resolve,
    signal: options.signal,
    onProgress: options.onProgress,
    targets: options.targets,
  };
};

const resolverFailure = (failure: { readonly fileName: string; readonly cause: unknown }): AssimpError =>
  new AssimpError('RESOLVE_FAILED', `Failed to resolve '${failure.fileName}'.`, failure);

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Wrap anything the engine throws that is not already typed. @internal */
export const engineFailure = (backend: NativeRuntime['backend'], error: unknown): AssimpError =>
  error instanceof AssimpError
    ? error
    : new AssimpError(
        'ENGINE_FAILED',
        `The ${backend} engine failed: ${describe(error)}.${
          backend === 'wasm' ? ' The Wasm runtime was discarded; the next conversion starts a fresh one.' : ''
        }`,
        { cause: error },
      );

const failureMessage = (result: PlanResult, entryName: string, backend: NativeRuntime['backend']): string => {
  const detail = result.message === '' ? undefined : result.message;
  if (result.code === 'LIMIT_EXCEEDED') {
    const where = result.format === undefined ? `importing '${entryName}'` : `exporting ${result.format}`;
    const remedy =
      backend === 'wasm'
        ? 'A Wasm instance is limited to 4 GiB; split the input, request fewer post-processing steps, or use the native backend on Node.js.'
        : 'Free memory on the host or split the input.';
    return `The conversion ran out of memory while ${where}${detail === undefined ? '' : ` (${detail})`}. ${remedy}`;
  }
  if (detail !== undefined) return detail;
  if (result.code === 'IMPORT_FAILED') return `assimp could not import '${entryName}' and gave no reason.`;
  if (result.code === 'EXPORT_FAILED') return `assimp's ${result.format} exporter failed and gave no reason.`;
  return `The conversion failed with ${result.code} and no message.`;
};

const knownCodes: ReadonlySet<string> = new Set<AssimpFailureCode>([
  'NO_FILES',
  'UNSUPPORTED_FORMAT',
  'INVALID_OPTIONS',
  'RESOLVE_FAILED',
  'IMPORT_FAILED',
  'EXPORT_FAILED',
  'LIMIT_EXCEEDED',
]);

const planFailure = (
  result: PlanResult,
  entryName: string,
  backend: NativeRuntime['backend'],
): AssimpError => {
  const context = {
    ...(result.formatIndex === undefined ? {} : { formatIndex: result.formatIndex }),
    ...(result.format === undefined ? {} : { format: result.format }),
  };
  if (!knownCodes.has(result.code)) {
    return new AssimpError(
      'INTERNAL',
      `libassimp invariant failed: the engine reported failure code '${result.code}' (${result.message}).`,
      context,
    );
  }
  return new AssimpError(
    result.code as AssimpFailureCode,
    failureMessage(result, entryName, backend),
    context,
  );
};

const warningsFrom = (
  warnings: readonly PlanWarning[],
  formats: readonly AllExportFormat[],
): ConversionWarning[] =>
  warnings.map(({ error, phase, formatIndex, message }) => {
    const name = progressPhases[phase] as ConversionPhase;
    return {
      severity: error ? 'error' : 'warning',
      phase: name,
      message,
      ...(name === 'export' ? { formatIndex, format: formats[formatIndex] as AllExportFormat } : {}),
    };
  });

/** Execute one already validated staged plan. @internal */
export const runPreparedConversion = async <
  const Targets extends readonly [ConvertTarget, ...ConvertTarget[]],
>(
  runtime: NativeRuntime,
  request: PreparedConversion<Targets>,
): Promise<ConvertFormatsResult<Targets>> => {
  const started = performance.now();
  const formats = request.targets.map(({ to }) => to);
  const context = new ResolutionContext(request.resolve, request.signal, {
    onProgress: request.onProgress,
    formats,
  });
  const entryName = request.files[0].name;
  let handle: unknown;
  let prepared = false;
  const state = { engineFailed: false };
  const guard = <Value>(call: () => Value): Value => {
    try {
      return call();
    } catch (error) {
      if (error instanceof AssimpError) throw error;
      state.engineFailed = true;
      throw engineFailure(runtime.backend, error);
    }
  };
  try {
    context.throwIfAborted();
    handle = guard(() => runtime.preparePlan(entryName, request.files, request.nativeOptions));
    prepared = true;
    context.setCancel(() => {
      runtime.cancelPlan(handle);
    });
    context.throwIfAborted();
    let status: number;
    for (;;) {
      context.resetOutputs();
      try {
        status = await runtime.runPlan(handle, context);
      } catch (error) {
        state.engineFailed = true;
        context.throwIfAborted();
        throw engineFailure(runtime.backend, error);
      }
      context.throwIfAborted();
      const failure = context.getFailure();
      if (failure !== undefined) throw resolverFailure(failure);
      if (status !== -1) break;
      const pending = context.takePending();
      if (pending.length === 0) {
        throw new AssimpError(
          'INTERNAL',
          'libassimp replay invariant failed: the engine asked for a replay without new resolver work.',
        );
      }
      await Promise.all(pending);
      context.throwIfAborted();
      const settledFailure = context.getFailure();
      if (settledFailure !== undefined) throw resolverFailure(settledFailure);
    }
    if (status === 3) {
      throw new AssimpError(
        'ABORTED',
        'The engine stopped this conversion before it finished, without an abort from its signal (the Node.js environment may be shutting down).',
      );
    }
    const result = guard(() => runtime.takePlanResult(handle));
    if (!result.ok) throw planFailure(result, entryName, runtime.backend);
    const outputFailure = context.getOutputFailure();
    if (outputFailure !== undefined) {
      throw new AssimpError(
        'LIMIT_EXCEEDED',
        `The host could not hold the converted output: ${describe(outputFailure.cause)}.`,
        outputFailure,
      );
    }
    const converted = result.formats.map(({ format, files }) => ({
      format,
      files: files.map(({ name, bytes, hostFile, size }) => ({
        name,
        bytes: bytes ?? context.takeOutput(hostFile as number, size as number),
      })),
    }));
    const timings = result.timings ?? { import: 0, postProcess: 0, export: 0 };
    const report: ConversionReport = {
      warnings: warningsFrom(result.warnings ?? [], formats),
      timings: { ...timings, total: performance.now() - started },
      peakMemoryBytes: runtime.peakMemoryBytes(),
    };
    return Object.assign(converted, report) as unknown as ConvertFormatsResult<Targets>;
  } finally {
    context.dispose();
    // After a trap the engine's heap is untrustworthy; the instance discards the whole runtime.
    if (prepared && !state.engineFailed) runtime.destroyPlan(handle);
  }
};
