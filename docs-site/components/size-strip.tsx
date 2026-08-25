import sizes from '../lib/sizes.json';

/** Format a byte count the way a package registry does: decimal units, one decimal place. */
export const formatSize = (bytes: number): string => {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  const kilobytes = bytes / 1_000;
  return `${kilobytes >= 100 ? kilobytes.toFixed(0) : kilobytes.toFixed(1)} KB`;
};

const cells = [
  {
    bytes: sizes.wasm.brotli,
    hint: 'libassimp.wasm, brotli-compressed',
    label: 'Wasm',
  },
  { bytes: sizes.js.gzip, hint: 'JavaScript entrypoint, gzip-compressed', label: 'JS API' },
];

/** Print the measured download sizes of the Wasm artifact and JavaScript API. */
export const SizeStrip = (): React.JSX.Element => (
  <dl className="my-6 grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-fd-border text-sm not-prose">
    {cells.map(({ bytes, hint, label }) => (
      <div className="bg-fd-card px-4 py-3" key={label} title={hint}>
        <dt className="font-mono text-xs text-fd-muted-foreground">{label}</dt>
        <dd className="mt-1 text-lg font-semibold">{formatSize(bytes)}</dd>
      </div>
    ))}
  </dl>
);
