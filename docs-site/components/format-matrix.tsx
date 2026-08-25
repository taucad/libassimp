import matrix from '../content/docs/format-matrix.json';

/** One row per importer, carrying every extension that importer claims. */
const importFamilies = (): ReadonlyArray<{ description: string; extensions: readonly string[] }> => {
  const families = new Map<string, string[]>();
  for (const { description, extension } of matrix.import) {
    families.set(description, [...(families.get(description) ?? []), extension]);
  }
  return [...families]
    .map(([description, extensions]) => ({ description, extensions }))
    .toSorted((left, right) => (left.description < right.description ? -1 : 1));
};

/** Every importer in the compiled artifact. */
export const ImportMatrix = (): React.JSX.Element => (
  <table>
    <thead>
      <tr>
        <th>Format</th>
        <th>Extensions</th>
      </tr>
    </thead>
    <tbody>
      {importFamilies().map(({ description, extensions }) => (
        <tr key={description}>
          <td>{description.replace(/ Importer$/u, '')}</td>
          <td>{extensions.map((extension) => `.${extension}`).join(' ')}</td>
        </tr>
      ))}
    </tbody>
  </table>
);

/** Every canonical exporter id accepted by the compiled artifact. */
export const ExportMatrix = (): React.JSX.Element => (
  <table>
    <thead>
      <tr>
        <th>Target id</th>
        <th>Writes</th>
      </tr>
    </thead>
    <tbody>
      {matrix.export.map(({ id, extension, description }) => (
        <tr key={id}>
          <td>
            <code>{id}</code>
          </td>
          <td>
            <code>result.{extension}</code> — {description}
          </td>
        </tr>
      ))}
    </tbody>
  </table>
);
