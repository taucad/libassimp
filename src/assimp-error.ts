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
 * - `IMPORT_FAILED` — assimp could not read the entry file, or a referenced
 *   sidecar was missing. Pass the missing bytes through `files` or `resolve`.
 * - `EXPORT_FAILED` — the scene imported but the exporter refused it, for
 *   example an export property outside the range the exporter accepts.
 *
 * @public
 */
export type AssimpFailureCode = 'NO_FILES' | 'UNSUPPORTED_FORMAT' | 'IMPORT_FAILED' | 'EXPORT_FAILED';

/**
 * Typed conversion failure carrying an {@link AssimpFailureCode}.
 *
 * @public
 */
export class AssimpError extends Error {
  /** Machine-readable classification of the failure. */
  public readonly code: AssimpFailureCode;

  /**
   * Construct a typed conversion failure.
   *
   * @param code - Failure taxonomy code.
   * @param message - Assimp's diagnostic text for the failed phase.
   */
  public constructor(code: AssimpFailureCode, message: string) {
    super(message);
    this.name = 'AssimpError';
    this.code = code;
  }
}
