---
libassimp: minor
---

Move the USD importer and exporter to LightUSD (the successor to TinyUSDZ) and add the `usdc` export target. USD sublayers, references and payloads, including USDA, USDC and MaterialX sidecars, resolve through `resolve`, and a composed scene exports as a self-contained USDZ that passes OpenUSD's ARKit compliance checks. Large USD scenes convert several times faster in a fraction of the memory. The Node-API worker gets an 8 MiB stack, Wasm `dispose` releases the instance's memory, and the module-level `convert` recycles its shared Wasm instance after a job grows linear memory past 512 MiB.
