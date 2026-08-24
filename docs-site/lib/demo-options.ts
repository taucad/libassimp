export type DemoValue = boolean | number | string;

export type DemoControl =
  | {
      readonly choices: readonly { readonly label: string; readonly value: DemoValue }[];
      readonly key: string;
      readonly kind: 'choice';
      readonly label: string;
    }
  | {
      readonly key: string;
      readonly kind: 'range';
      readonly label: string;
      readonly max: number;
      readonly min: number;
      readonly step: number;
    }
  | { readonly key: string; readonly kind: 'text'; readonly label: string };

const targets = {
  exporter: ['usdz', '3mf', 'stl', 'obj', 'ply'],
  full: ['glb', 'gltf', 'usdz', '3mf', 'stl', 'ply', 'assjson'],
  importer: ['glb', 'gltf', 'assjson'],
} as const;

const targetLabels: Readonly<Record<string, string>> = {
  '3mf': '3MF · print package',
  assjson: 'Assimp JSON · inspect scene',
  glb: 'GLB · one web binary',
  gltf: 'glTF · JSON + sidecar',
  obj: 'OBJ · mesh + sidecar',
  ply: 'PLY · polygon data',
  stl: 'STL · triangle mesh',
  usdz: 'USDZ · Apple Quick Look',
};

const properties = [
  {
    choices: [
      { label: 'Micrometre', value: 'micron' },
      { label: 'Millimetre', value: 'millimeter' },
      { label: 'Centimetre', value: 'centimeter' },
      { label: 'Inch', value: 'inch' },
      { label: 'Foot', value: 'foot' },
      { label: 'Metre', value: 'meter' },
    ],
    key: 'unit',
    kind: 'choice',
    label: '3MF unit',
  },
  {
    key: 'decimalPrecision',
    kind: 'range',
    label: 'Decimal digits',
    max: 16,
    min: 1,
    step: 1,
  },
  { key: 'application', kind: 'text', label: 'Application' },
  {
    choices: [
      { label: 'X up', value: 'x' },
      { label: 'Y up', value: 'y' },
      { label: 'Z up', value: 'z' },
    ],
    key: 'upAxis',
    kind: 'choice',
    label: 'Up axis',
  },
] as const satisfies readonly DemoControl[];

const importEntry = /from\s+['"]libassimp(?:\/(importer|exporter))?['"]/u;
const targetLiteral = /\bto\s*:\s*(['"])([^'"]+)\1/u;

/** Which published entry the example imports. */
const readDemoEntry = (code: string): keyof typeof targets => {
  const entry = importEntry.exec(code)?.[1];
  return entry === 'importer' || entry === 'exporter' ? entry : 'full';
};

/** Read the target and any supported exporter properties authored in an example. */
export const readDemoOptions = (code: string): Record<string, DemoValue> => {
  const values: Record<string, DemoValue> = {};
  const target = targetLiteral.exec(code)?.[2];
  if (target !== undefined) values['to'] = target;

  for (const control of properties) {
    const escaped = control.key.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const literal = new RegExp(`(?:['"])?${escaped}(?:['"])?\\s*:\\s*([^,\\n}]+)`, 'u')
      .exec(code)?.[1]
      ?.trim();
    if (literal === undefined) continue;
    if (/^['"].*['"]$/u.test(literal)) values[control.key] = literal.slice(1, -1);
    else if (literal === 'true' || literal === 'false') values[control.key] = literal === 'true';
    else if (Number.isFinite(Number(literal))) values[control.key] = Number(literal);
  }

  return values;
};

/** Controls that can rewrite values the example already contains. */
export const demoControls = (code: string): readonly DemoControl[] => {
  const entry = readDemoEntry(code);
  const current = readDemoOptions(code);
  const target = String(current['to'] ?? 'glb');
  const validTargets = [...targets[entry]];
  if (!validTargets.includes(target as never)) validTargets.push(target as never);

  const targetControl: DemoControl = {
    choices: validTargets.map((value) => ({ label: targetLabels[value] ?? value, value })),
    key: 'to',
    kind: 'choice',
    label: 'Output',
  };
  return [targetControl, ...properties.filter(({ key }) => key in current)];
};

const formatLiteral = (value: DemoValue, quote: string): string =>
  typeof value === 'string'
    ? `${quote}${value.replaceAll('\\', '\\\\').replaceAll(quote, `\\${quote}`)}${quote}`
    : String(value);

/** Rewrite the displayed example so copied code matches the controls. */
export const substituteDemoValues = (
  code: string,
  values: Readonly<Partial<Record<string, DemoValue>>>,
): string => {
  let rewritten = code;
  const target = values['to'];
  if (target !== undefined) {
    rewritten = rewritten.replace(targetLiteral, (literal, quote: string, current: string) =>
      current === target
        ? literal
        : literal.replace(`${quote}${current}${quote}`, formatLiteral(target, quote)),
    );
  }

  for (const control of properties) {
    const value = values[control.key];
    if (value === undefined) continue;
    const escaped = control.key.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const literal = new RegExp(`((?:['"])?${escaped}(?:['"])?\\s*:\\s*)([^,\\n}]+)`, 'u');
    rewritten = rewritten.replace(literal, (match, prefix: string) => {
      const current = match.slice(prefix.length);
      const next = formatLiteral(value, "'");
      return current.trim() === next ? match : `${prefix}${next}`;
    });
  }

  return rewritten;
};
