/**
 * The export vocabulary each entry accepts: assimp's own exporter ids plus six
 * friendly aliases (`glb`, `gltf`, `glb1`, `gltf1`, `step`, `dae`). The unions
 * are written out here and asserted against the compiled build by
 * `src/formats.test.ts`, so a `variants.json` edit that changes what an entry
 * exports fails a test rather than drifting from the types.
 *
 * `glb` and `gltf` name glTF 2.0 (assimp's `glb2` and `gltf2`), glTF 1.0 moves
 * to `glb1` and `gltf1`, `step` resolves to `stp`, and `dae` to `collada`.
 */

/** One entry in the compiled format table. @public */
export type FormatInfo = {
  /** Assimp's format id, the value `ConvertOptions.to` takes. */
  readonly id: string;
  /** File extension assimp gives the output, without a dot. */
  readonly extension: string;
  /** Assimp's human-readable name for the format. */
  readonly description: string;
};

/**
 * Export targets the `libassimp` and `libassimp/exporter` builds accept: every
 * exporter assimp builds cleanly, plus the aliases.
 */
export type AllExportFormat =
  | '3ds'
  | '3mf'
  | 'assjson'
  | 'collada'
  | 'dae'
  | 'fbx'
  | 'fbxa'
  | 'glb'
  | 'glb1'
  | 'glb2'
  | 'gltf'
  | 'gltf1'
  | 'gltf2'
  | 'obj'
  | 'objnomtl'
  | 'ply'
  | 'plyb'
  | 'step'
  | 'stl'
  | 'stlb'
  | 'stp'
  | 'usda'
  | 'usdz'
  | 'x'
  | 'x3d';

/**
 * Export targets the `libassimp/importer` build accepts: the glTF exporters
 * and assimp's JSON scene dump, plus the aliases that resolve to them.
 */
export type GltfExportFormat = 'assjson' | 'glb' | 'glb1' | 'glb2' | 'gltf' | 'gltf1' | 'gltf2';
