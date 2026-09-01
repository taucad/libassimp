/**
 * Failure taxonomy for conversions. Every code the binding can return has a
 * caller-visible remedy, and the message carries assimp's own diagnostic text.
 */

/**
 * Stable failure classification carried by {@link AssimpError}.
 *
 * - `NO_FILES` — `convert` was handed an empty array.
 * - `UNSUPPORTED_FORMAT` — the `to` id is not compiled into this entry; the
 *   message lists the ids this entry does export.
 * - `INVALID_OPTIONS` — a public option is unknown, has the wrong value, is
 *   not applicable to the target, or conflicts with another option.
 * - `RESOLVE_FAILED` — a sidecar resolver threw or rejected.
 * - `IMPORT_FAILED` — assimp could not read the entry file, or a referenced
 *   sidecar was missing. Pass the missing bytes through `files` or `resolve`.
 * - `EXPORT_FAILED` — the scene imported but the exporter refused it, for
 *   example an export property outside the range the exporter accepts.
 *
 * @public
 */
export type AssimpFailureCode =
  | 'NO_FILES'
  | 'UNSUPPORTED_FORMAT'
  | 'INVALID_OPTIONS'
  | 'RESOLVE_FAILED'
  | 'IMPORT_FAILED'
  | 'EXPORT_FAILED';

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
 * @public
 */
export class AssimpError extends Error {
  /** Machine-readable classification of the failure. */
  public readonly code: AssimpFailureCode;
  /** Zero-based target position for an export failure. */
  public readonly formatIndex?: number;
  /** Canonical public target format for an export failure. */
  public readonly format?: string;
  /** Exact requested name for a resolver failure. */
  public readonly fileName?: string;

  /**
   * Construct a typed conversion failure.
   *
   * @param code - Failure taxonomy code.
   * @param message - Assimp's diagnostic text for the failed phase.
   */
  public constructor(code: AssimpFailureCode, message: string, context: AssimpErrorContext = {}) {
    super(message, context.cause === undefined ? undefined : { cause: context.cause });
    this.name = 'AssimpError';
    this.code = code;
    if (context.formatIndex !== undefined) this.formatIndex = context.formatIndex;
    if (context.format !== undefined) this.format = context.format;
    if (context.fileName !== undefined) this.fileName = context.fileName;
  }
}
