// Selects the backend the shared suites run against. The Wasm run imports the
// TypeScript facade over the working Wasm build; the native run
// (`vitest.native.config.ts`, CI's smoke job) imports the built Node entry with
// the target's addon in `dist/native`. Both runs pin the same fingerprints.
export const backend = process.env['LIBASSIMP_TEST_BACKEND'] === 'native' ? 'native' : 'wasm';

/** Create an instance of the backend under test, refusing a silent fallback. */
export const createTestAssimp = async () => {
  if (backend === 'wasm') {
    const { createAssimp } = await import('../src/index.ts');
    return createAssimp();
  }
  const { createAssimp } = await import('../dist/index.node.mjs');
  const assimp = await createAssimp({ backend: 'native' });
  if (assimp.backend !== 'native') throw new Error(`expected the native backend, got ${assimp.backend}`);
  return assimp;
};
