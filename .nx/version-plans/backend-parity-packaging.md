---
libassimp: minor
---

Move option and post-process descriptions out of the root entry into a new lazy `libassimp/capabilities` subpath, which exports the same `assimpCapabilities` registry with a `description` on every option and step. The root entry's static JavaScript shrinks from 218.2 kB to 79.3 kB (43.0 kB to 15.2 kB gzip), and descriptions no longer repeat their type and default. The format matrix, determinism fingerprints and USD suite now run on the native backend as well as Wasm, with every remaining difference documented in the test. esbuild's default browser build no longer fails on the Node-only `node:fs/promises` import, and CI now installs the packed tarball into Vite, webpack 5, Next.js (Turbopack), esbuild and a CDN-style host and converts a model in Chromium in each.
