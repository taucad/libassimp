import path from 'node:path';

// Initial public package contract from the blueprint's Target Package Manifest.
// Change the list and ceiling together in the causing pull request.
// Origin: the generated capability registry and validator split measured in the
// single-artifact candidate; 22 exact files, with no spare allowance.
const PACKAGE_FILE_COUNT_CEILING = 22;

export const PACKAGE_FILES = [
  'BREAKING_CHANGES.md',
  'CHANGELOG.md',
  'NOTICE',
  'README.md',
  'compatibility.md',
  'dist/assimp-error.d.mts',
  'dist/assimp-error.mjs',
  'dist/assimp-options.mjs',
  'dist/cjs-error.cjs',
  'dist/cjs-error.d.cts',
  'dist/convert.d.mts',
  'dist/convert.mjs',
  'dist/create-assimp.d.mts',
  'dist/create-assimp.mjs',
  'dist/generated/assimp-capabilities.d.mts',
  'dist/generated/assimp-capabilities.mjs',
  'dist/index.d.mts',
  'dist/index.mjs',
  'dist/wasm/libassimp.js',
  'dist/wasm/libassimp.wasm',
  'license',
  'package.json',
].sort();

const FORBIDDEN = [
  /\.(?:cpp|hpp|cmake|js\.symbols)$/u,
  /\.d\.ts\.map$/u,
  /(?:^|\/)manifest\.json$/u,
  /(?:^|\/)build\//u,
];

export const validatePackageFiles = (files) => {
  const normalized = files.map((file) => file.replaceAll(path.sep, '/')).sort();
  const missing = PACKAGE_FILES.filter((file) => !normalized.includes(file));
  const extra = normalized.filter((file) => !PACKAGE_FILES.includes(file));
  const forbidden = normalized.filter((file) => FORBIDDEN.some((pattern) => pattern.test(file)));

  if (
    normalized.length > PACKAGE_FILE_COUNT_CEILING ||
    missing.length > 0 ||
    extra.length > 0 ||
    forbidden.length > 0
  ) {
    throw new Error(
      `npm package mismatch; count=${normalized.length}/${PACKAGE_FILE_COUNT_CEILING} ` +
        `missing=[${missing.join(', ')}] extra=[${extra.join(', ')}] forbidden=[${forbidden.join(', ')}]`,
    );
  }

  return normalized;
};
