/**
 * Failure taxonomy for conversions. Every code the binding can return has a
 * caller-visible remedy, and the message carries assimp's own diagnostic text
 * when assimp gave one.
 */

/**
 * Stable failure classification carried by {@link AssimpError}.
 *
 * - `NO_FILES`, `INVALID_OPTIONS`, `UNSUPPORTED_FORMAT` — the request was
 *   rejected before any engine work, including empty or repeated file names.
 * - `RESOLVE_FAILED` — a sidecar resolver threw or rejected.
 * - `IMPORT_FAILED` / `EXPORT_FAILED` — assimp refused the input or the target.
 * - `LIMIT_EXCEEDED` — the conversion ran out of memory.
 * - `ENGINE_FAILED` — the engine trapped; a Wasm runtime is replaced.
 * - `BACKEND_UNAVAILABLE` — the requested native backend cannot load here.
 * - `ABORTED` — the engine stopped without the caller's signal, for example
 *   at Node.js shutdown. A signal abort rejects with the signal's `reason`.
 * - `INTERNAL` — a libassimp invariant failed; please report it.
 *
 * @public
 */
export type AssimpFailureCode =
  | 'NO_FILES'
  | 'UNSUPPORTED_FORMAT'
  | 'INVALID_OPTIONS'
  | 'RESOLVE_FAILED'
  | 'IMPORT_FAILED'
  | 'EXPORT_FAILED'
  | 'LIMIT_EXCEEDED'
  | 'ENGINE_FAILED'
  | 'BACKEND_UNAVAILABLE'
  | 'ABORTED'
  | 'INTERNAL';

/** Typed positional context for conversion failures. @public */
export type AssimpErrorContext = {
  readonly formatIndex?: number;
  readonly format?: string;
  readonly fileName?: string;
  readonly cause?: unknown;
};

/**
 * Typed conversion failure carrying an {@link AssimpFailureCode}.
 *
 * Context fields that do not apply are absent, not present as `undefined`:
 * `'formatIndex' in error` is `true` only for a failure tied to one target.
 *
 * @public
 */
export class AssimpError extends Error {
  /** Machine-readable classification of the failure. */
  public readonly code: AssimpFailureCode;
  /** Zero-based target position for an export failure. */
  declare public readonly formatIndex?: number;
  /** Canonical public target format for an export failure. */
  declare public readonly format?: string;
  /** Exact requested name for a resolver failure. */
  declare public readonly fileName?: string;

  /**
   * Construct a typed conversion failure.
   *
   * @param code - Failure taxonomy code.
   * @param message - Diagnostic text for the failed phase.
   * @param context - Optional target, file name, and cause.
   */
  public constructor(code: AssimpFailureCode, message: string, context: AssimpErrorContext = {}) {
    super(message, context.cause === undefined ? undefined : { cause: context.cause });
    this.name = 'AssimpError';
    this.code = code;
    // `declare` keeps these fields out of the emitted class body, so an unset one stays absent.
    if (context.formatIndex !== undefined) this.formatIndex = context.formatIndex;
    if (context.format !== undefined) this.format = context.format;
    if (context.fileName !== undefined) this.fileName = context.fileName;
  }
}
