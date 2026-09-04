import { expectTypeOf, test } from 'vitest';

import * as browser from './index.js';
import * as node from './index.node.js';

test('Node and browser entries expose one public type surface', () => {
  expectTypeOf<keyof typeof node>().toEqualTypeOf<keyof typeof browser>();
  expectTypeOf(node.convert).toEqualTypeOf<typeof browser.convert>();
  expectTypeOf(node.convertFormats).toEqualTypeOf<typeof browser.convertFormats>();
  expectTypeOf(node.createAssimp).toEqualTypeOf<typeof browser.createAssimp>();
  expectTypeOf<node.Assimp>().toEqualTypeOf<browser.Assimp>();
  expectTypeOf<Awaited<ReturnType<typeof node.createAssimp>>['backend']>().toEqualTypeOf<'native' | 'wasm'>();
});

test('both entries accept the same optional cancellation signal', () => {
  const signal = new AbortController().signal;
  void browser.convert({ name: 'model.obj', bytes: new Uint8Array() }, { to: 'glb', signal });
  void node.convertFormats(
    { name: 'model.obj', bytes: new Uint8Array() },
    { targets: [{ to: 'glb' }], signal },
  );
});
