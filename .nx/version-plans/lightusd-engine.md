---
libassimp: minor
---

Move the USD importer and exporter to LightUSD (the successor to TinyUSDZ) and add the `usdc` export target. USD sublayers, references and payloads, including USDA, USDC and MaterialX sidecars, resolve through `resolve`, and a composed scene exports as a self-contained USDZ that passes OpenUSD's ARKit compliance checks. Large USD scenes convert several times faster in a fraction of the memory. The Node-API worker gets an 8 MiB stack, Wasm `dispose` releases the instance's memory, and the module-level `convert` recycles its shared Wasm instance after a job grows linear memory past 512 MiB.

**Breaking.** The USD export options `materialX`, `subdivision`, `volumes` and `optimizeForMobile` are removed, and passing one now rejects with `INVALID_OPTIONS`; strip them from saved settings before upgrading (see the 0.4 upgrade guide). USD output changes for the same input: UVs are no longer flipped, and the exporters author `metersPerUnit` on the stage instead of baking the unit scale into geometry, so USD bytes, texture coordinates and transforms differ from 0.3.
