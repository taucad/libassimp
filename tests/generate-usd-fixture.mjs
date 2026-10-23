#!/usr/bin/env node

// Deterministic USD workloads for the USD benchmark and the sidecar tests.
// Everything is generated, so no third-party asset is redistributed.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const encoder = new TextEncoder();

const header = (defaultPrim) =>
  `#usda 1.0\n(\n    defaultPrim = "${defaultPrim}"\n    metersPerUnit = 1\n    upAxis = "Y"\n)\n\n`;

/** A `side` x `side` vertex grid of quads with normals and UVs, as one USDA mesh. */
export const usdaGrid = (side) => {
  if (!Number.isSafeInteger(side) || side < 2) throw new Error('grid side must be an integer of at least 2');
  const cells = side - 1;
  const points = [];
  const st = [];
  for (let row = 0; row < side; row += 1) {
    for (let column = 0; column < side; column += 1) {
      const height = ((row * 7 + column * 13) % 17) / 170;
      points.push(`(${column}, ${height}, ${row})`);
      st.push(`(${column / cells}, ${row / cells})`);
    }
  }
  const indices = [];
  for (let row = 0; row < cells; row += 1) {
    for (let column = 0; column < cells; column += 1) {
      const corner = row * side + column;
      indices.push(corner, corner + side, corner + side + 1, corner + 1);
    }
  }
  const counts = Array.from({ length: cells * cells }, () => 4);
  return encoder.encode(
    `${header('Grid')}def Xform "Grid" (\n    kind = "component"\n)\n{\n` +
      `    def Mesh "Surface" (\n        prepend apiSchemas = ["MaterialBindingAPI"]\n    )\n    {\n` +
      `        int[] faceVertexCounts = [${counts.join(', ')}]\n` +
      `        int[] faceVertexIndices = [${indices.join(', ')}]\n` +
      `        point3f[] points = [${points.join(', ')}]\n` +
      `        texCoord2f[] primvars:st = [${st.join(', ')}] (\n            interpolation = "vertex"\n        )\n` +
      `        uniform token subdivisionScheme = "none"\n` +
      `        rel material:binding = </Grid/Looks/Surface>\n    }\n\n` +
      `    def Scope "Looks"\n    {\n        def Material "Surface"\n        {\n` +
      `            token outputs:surface.connect = </Grid/Looks/Surface/Preview.outputs:surface>\n\n` +
      `            def Shader "Preview"\n            {\n                uniform token info:id = "UsdPreviewSurface"\n` +
      `                color3f inputs:diffuseColor = (0.8, 0.5, 0.2)\n                float inputs:roughness = 0.4\n` +
      `                token outputs:surface\n            }\n        }\n    }\n}\n`,
  );
};

const cube = (name, offset) =>
  `    def Mesh "${name}"\n    {\n` +
  `        float3[] extent = [(${offset - 0.5}, -0.5, -0.5), (${offset + 0.5}, 0.5, 0.5)]\n` +
  '        int[] faceVertexCounts = [4, 4, 4, 4, 4, 4]\n' +
  '        int[] faceVertexIndices = [0, 1, 3, 2, 2, 3, 7, 6, 6, 7, 5, 4, 4, 5, 1, 0, 2, 6, 4, 0, 7, 3, 1, 5]\n' +
  `        point3f[] points = [${[
    [-0.5, -0.5, 0.5],
    [0.5, -0.5, 0.5],
    [-0.5, 0.5, 0.5],
    [0.5, 0.5, 0.5],
    [-0.5, -0.5, -0.5],
    [0.5, -0.5, -0.5],
    [-0.5, 0.5, -0.5],
    [0.5, 0.5, -0.5],
  ]
    .map(([x, y, z]) => `(${x + offset}, ${y}, ${z})`)
    .join(', ')}]\n` +
  '        uniform token subdivisionScheme = "none"\n    }\n';

/**
 * A root USDA that pulls geometry from a sublayer and a reference, and a
 * material from a MaterialX document. Returns the root and its sidecars.
 */
export const usdSidecarScene = () => ({
  root: {
    name: 'scene.usda',
    bytes: encoder.encode(
      '#usda 1.0\n(\n    defaultPrim = "World"\n    metersPerUnit = 1\n    upAxis = "Y"\n' +
        '    subLayers = [\n        @./layers/base.usda@\n    ]\n)\n\n' +
        'over "World"\n{\n' +
        '    def Xform "Part" (\n        prepend references = @./parts/part.usda@\n    )\n    {\n' +
        '        double3 xformOp:translate = (0, 2, 0)\n        uniform token[] xformOpOrder = ["xformOp:translate"]\n\n' +
        '        over "Body" (\n            prepend apiSchemas = ["MaterialBindingAPI"]\n        )\n        {\n' +
        '            rel material:binding = </World/Looks/Materials/Brass>\n        }\n    }\n\n' +
        '    def Scope "Looks" (\n        prepend references = @./materials/brass.mtlx@</MaterialX>\n    )\n    {\n    }\n}\n',
    ),
  },
  sidecars: new Map([
    ['layers/base.usda', encoder.encode(`#usda 1.0\n\ndef Xform "World"\n{\n${cube('Base', 0)}}\n`)],
    ['parts/part.usda', encoder.encode(`${header('Part')}def Xform "Part"\n{\n${cube('Body', 3)}}\n`)],
    [
      'materials/brass.mtlx',
      encoder.encode(
        '<?xml version="1.0"?>\n<materialx version="1.38">\n' +
          '  <standard_surface name="SR_brass" type="surfaceshader">\n' +
          '    <input name="base_color" type="color3" value="1, 0.766, 0.336" />\n' +
          '    <input name="metalness" type="float" value="1" />\n' +
          '    <input name="specular_roughness" type="float" value="0.25" />\n' +
          '  </standard_surface>\n' +
          '  <surfacematerial name="Brass" type="material">\n' +
          '    <input name="surfaceshader" type="surfaceshader" nodename="SR_brass" />\n' +
          '  </surfacematerial>\n</materialx>\n',
      ),
    ],
  ]),
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { side: { type: 'string', default: '512' } },
  });
  if (positionals.length !== 1) throw new Error('expected one output path');
  const bytes = usdaGrid(Number(values.side));
  writeFileSync(positionals[0], bytes);
  process.stdout.write(`${bytes.length}\n`);
}
