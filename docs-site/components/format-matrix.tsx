import matrix from '../content/docs/format-matrix.json';

type Variant = keyof typeof matrix;

const VARIANTS: readonly Variant[] = ['full', 'importer', 'exporter'];
const HEADINGS: Readonly<Record<Variant, string>> = {
  full: 'libassimp',
  importer: '/importer',
  exporter: '/exporter',
};

const mark = (present: boolean): string => (present ? 'yes' : '—');

/** The ids each build carries, one set per entry, for the presence columns. */
const idSets = (kind: 'import' | 'export'): Record<Variant, ReadonlySet<string>> => ({
  full: new Set(matrix.full[kind].map(({ id }) => id)),
  importer: new Set(matrix.importer[kind].map(({ id }) => id)),
  exporter: new Set(matrix.exporter[kind].map(({ id }) => id)),
});

const importIds = idSets('import');
const exportIds = idSets('export');

/** One row per importer, carrying every extension that importer claims. */
const importFamilies = (): ReadonlyArray<{ description: string; extensions: readonly string[] }> => {
  const families = new Map<string, string[]>();
  for (const { description, extension } of matrix.full.import) {
    families.set(description, [...(families.get(description) ?? []), extension]);
  }
  return [...families]
    .map(([description, extensions]) => ({ description, extensions }))
    .toSorted((left, right) => (left.description < right.description ? -1 : 1));
};

const VariantHeadings = (): React.JSX.Element[] =>
  VARIANTS.map((variant) => <th key={variant}>{HEADINGS[variant]}</th>);

/** Every importer each build carries, read out of the compiled tables. */
export const ImportMatrix = (): React.JSX.Element => (
  <table>
    <thead>
      <tr>
        <th>Format</th>
        <th>Extensions</th>
        <VariantHeadings />
      </tr>
    </thead>
    <tbody>
      {importFamilies().map(({ description, extensions }) => (
        <tr key={description}>
          <td>{description.replace(/ Importer$/u, '')}</td>
          <td>{extensions.map((extension) => `.${extension}`).join(' ')}</td>
          {VARIANTS.map((variant) => (
            <td key={variant}>{mark(extensions.some((extension) => importIds[variant].has(extension)))}</td>
          ))}
        </tr>
      ))}
    </tbody>
  </table>
);

/** Every exporter id each build accepts, with the file name it writes. */
export const ExportMatrix = (): React.JSX.Element => (
  <table>
    <thead>
      <tr>
        <th>Target id</th>
        <th>Writes</th>
        <VariantHeadings />
      </tr>
    </thead>
    <tbody>
      {matrix.full.export.map(({ id, extension, description }) => (
        <tr key={id}>
          <td>
            <code>{id}</code>
          </td>
          <td>
            <code>result.{extension}</code> — {description}
          </td>
          {VARIANTS.map((variant) => (
            <td key={variant}>{mark(exportIds[variant].has(id))}</td>
          ))}
        </tr>
      ))}
    </tbody>
  </table>
);
