---
libassimp: minor
---

Move option and post-process descriptions out of the root entry into a new lazy `libassimp/capabilities` subpath, which exports the same `assimpCapabilities` registry with a `description` on every option and step. The root entry's static JavaScript shrinks from 227.7 kB to 82.6 kB (43.6 kB to 15.4 kB gzip), and descriptions no longer repeat their type and default. The format matrix, determinism fingerprints and USD suite now run on the native backend as well as Wasm, with every remaining difference documented in the test.
