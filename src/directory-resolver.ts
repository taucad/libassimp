/** Node-only sidecar resolver confined to one directory tree. */

import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ResolveFile } from './convert.js';

const missingCodes: ReadonlySet<unknown> = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'ELOOP', 'ENAMETOOLONG']);

const within = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
};

/**
 * Create a {@link ResolveFile} that reads sidecars from `root` and never from
 * outside it.
 *
 * Names arrive exactly as the model authored them (`textures/wood.png`,
 * `../shared/a.mtl`, `/etc/passwd`, `C:\\x.png`). Each name is resolved
 * relative to `root` with `/` and `\\` as separators. A name that is absolute,
 * contains a NUL byte, escapes `root` lexically, or reaches outside `root`
 * through a symbolic link resolves as missing, as does a file that does not
 * exist. Other I/O errors (for example `EACCES`) reject, which the conversion
 * reports as `RESOLVE_FAILED`.
 *
 * @param root - Directory (path or `file:` URL) that contains the entry file's sidecars.
 * @returns A resolver to pass as `resolve`.
 *
 * @example
 * ```ts
 * import { readFile } from 'node:fs/promises';
 * import { convert, createDirectoryResolver } from 'libassimp';
 *
 * const bytes = new Uint8Array(await readFile('models/chair.obj'));
 * const { files } = await convert(
 *   { name: 'chair.obj', bytes },
 *   { to: 'glb', resolve: createDirectoryResolver('models') },
 * );
 * ```
 *
 * @public
 */
export const createDirectoryResolver = (root: string | URL): ResolveFile => {
  const base = resolve(root instanceof URL ? fileURLToPath(root) : root);
  let realBase: Promise<string> | undefined;
  return async (name) => {
    const normalized = name.replaceAll('\\', '/');
    if (normalized.includes('\0') || normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized))
      return undefined;
    const candidate = resolve(base, ...normalized.split('/'));
    if (!within(base, candidate)) return undefined;
    try {
      realBase ??= realpath(base);
      const [contained, target] = await Promise.all([realBase, realpath(candidate)]);
      if (!within(contained, target)) return undefined;
      return await readFile(target);
    } catch (error) {
      if (missingCodes.has((error as { code?: unknown }).code)) return undefined;
      throw error;
    }
  };
};
