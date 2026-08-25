import { describe, expect, it } from 'vitest';

import { PACKAGE_FILES, validatePackageFiles } from '../scripts/package-files.mjs';

describe('npm package file contract', () => {
  it('accepts exactly the public package files', () => {
    expect(validatePackageFiles([...PACKAGE_FILES].reverse())).toEqual(PACKAGE_FILES);
  });

  it('rejects missing, extra, and source files', () => {
    expect(() => validatePackageFiles(PACKAGE_FILES.slice(1))).toThrow('missing=[');
    expect(() => validatePackageFiles([...PACKAGE_FILES, 'dist/accidental.txt'])).toThrow('extra=[');
    expect(() => validatePackageFiles([...PACKAGE_FILES, 'src/cpp/libassimp.cpp'])).toThrow(
      'forbidden=[src/cpp/libassimp.cpp]',
    );
    expect(() => validatePackageFiles([...PACKAGE_FILES, 'dist/wasm/libassimp.js.symbols'])).toThrow(
      'forbidden=[dist/wasm/libassimp.js.symbols]',
    );
  });
});
