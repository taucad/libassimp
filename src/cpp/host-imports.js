// Copyright 2026 Richard Fontein
// SPDX-License-Identifier: Apache-2.0

// The explicit allowlist for -sERROR_ON_UNDEFINED_SYMBOLS=1. Every symbol here
// is imported from a module the host fills at instantiation (libassimp.cpp's
// `libassimp.dispatch`), never from Emscripten's `env`, so these definitions
// reach no Wasm import and the glue still leaves exactly that one import for
// create-assimp.ts to supply. Any other undefined symbol fails the link.
/* global addToLibrary -- Emscripten JS-library API, defined while linking. */
addToLibrary({
  dispatch: () => {
    throw new Error('libassimp.dispatch is supplied by the host at instantiation');
  },
});
