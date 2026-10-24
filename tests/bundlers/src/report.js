// Shared by every fixture: convert the bundled cube.obj and publish the result
// on `window` for scripts/test-bundlers.mjs to compare with Node's output.
import { cube } from './cube.js';

export const report = async (loadConvert) => {
  try {
    const convert = await loadConvert();
    const { files } = await convert(
      { name: 'cube.obj', bytes: new TextEncoder().encode(cube) },
      { to: 'glb' },
    );
    window.__libassimp = { ok: true, name: files[0].name, bytes: Array.from(files[0].bytes) };
  } catch (error) {
    window.__libassimp = { ok: false, error: String(error?.stack ?? error) };
  }
};
