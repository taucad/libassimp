---
libassimp: minor
---

Exports are faster and use less memory. A GLB or glTF export keeps the imported scene's shared vertices indexed instead of writing every triangle corner out separately. Exporters that only read the scene no longer copy it first. Vertex joining uses a hash table, the OBJ, STL, PLY, COLLADA and STEP writers stream their text, the glTF buffer grows geometrically, and a GLB's binary chunk is read in place. STEP output no longer depends on memory addresses, and a point-cloud PLY now exports to STL and PLY. The new 3MF export option `requireManifold` (default `true`) can be set to `false` to write open surfaces as 3MF objects of type `other` instead of failing. Files whose scene graph nests deeper than 1000 levels, or whose nodes form a cycle, are rejected with `IMPORT_FAILED` instead of overflowing the stack. 3MF and COLLADA files with out-of-range indices are rejected the same way instead of being read out of bounds.
