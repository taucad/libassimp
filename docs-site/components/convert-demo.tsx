'use client';

import { DynamicCodeBlock } from 'fumadocs-ui/components/dynamic-codeblock';
import { AssimpError, type ConvertOptions } from 'libassimp';
import { useEffect, useMemo, useRef, useState } from 'react';

import { hasQuickLook, hasWebAssembly, isAssimpLoaded, launchQuickLook, loadAssimp } from '@/lib/assimp-demo';
import {
  demoControls,
  demoExportOptions,
  isDemoExportFormat,
  readDemoOptions,
  substituteDemoValues,
  type DemoValue,
} from '@/lib/demo-options';

import styles from './convert-demo.module.css';

const CUBE_GEOMETRY = `v -1 -1 -1
v -1 -1 1
v -1 1 -1
v -1 1 1
v 1 -1 -1
v 1 -1 1
v 1 1 -1
v 1 1 1
f 1 2 4 3
f 5 7 8 6
f 1 5 6 2
f 3 4 8 7
f 1 3 7 5
f 2 6 8 4
`;
const CUBE_OBJ = `mtllib cube.mtl
usemtl shell
${CUBE_GEOMETRY}`;
const CUBE_MTL = `newmtl shell
Kd 0.12 0.48 0.76
Ks 0.16 0.16 0.16
Ns 32
`;
const MIME: Readonly<Record<string, string>> = {
  '3mf': 'model/3mf',
  assjson: 'application/json',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  obj: 'text/plain',
  ply: 'application/octet-stream',
  stl: 'model/stl',
  usdz: 'model/vnd.usdz+zip',
};
const codeblockProps = { className: 'my-0 rounded-none border-0 shadow-none' };

type DemoFile = {
  readonly bytes: number;
  readonly magic: string;
  readonly mime: string;
  readonly name: string;
  readonly url: string;
};

type Outcome =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly phase: 'convert' | 'load' }
  | { readonly kind: 'failed'; readonly code?: string; readonly message: string }
  | {
      readonly files: readonly DemoFile[];
      readonly inputBytes: number;
      readonly kind: 'done';
      readonly loadMs: number;
      readonly ms: number;
    };

const encode = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);
const extension = (name: string): string => name.split('.').at(-1) ?? 'file';
const formatBytes = (bytes: number): string =>
  bytes < 1_000
    ? `${bytes} B`
    : bytes < 1_000_000
      ? `${(bytes / 1_000).toFixed(1)} KB`
      : `${(bytes / 1_000_000).toFixed(1)} MB`;
const magic = (bytes: Uint8Array): string =>
  Array.from(bytes.slice(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join(' ');

const inputFiles = (
  code: string,
): readonly { readonly name: string; readonly bytes: Uint8Array<ArrayBuffer> }[] => {
  if (code.includes('broken.obj')) return [{ name: 'broken.obj', bytes: encode('v 0 0\nf 99 100 101\n') }];
  if (!code.includes('cube.mtl') && !code.includes('resolve:')) {
    return [{ name: 'cube.obj', bytes: encode(CUBE_GEOMETRY) }];
  }
  return [
    { name: 'cube.obj', bytes: encode(CUBE_OBJ) },
    { name: 'cube.mtl', bytes: encode(CUBE_MTL) },
  ];
};

/** A live, code-driven conversion bench shared by every documentation page. */
export const ConvertDemo = ({
  code,
  lang = 'typescript',
}: {
  readonly code: string;
  readonly lang?: string;
  /** The MDX fence stays a child for Markdown projection; the dynamic block renders instead. */
  readonly children?: React.ReactNode;
}): React.JSX.Element => {
  const controls = useMemo(() => demoControls(code), [code]);
  const [values, setValues] = useState<Record<string, DemoValue>>(() => readDemoOptions(code));
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  const urlsRef = useRef<readonly string[]>([]);
  const generationRef = useRef(0);
  const mountedRef = useRef(false);
  const supported = hasWebAssembly();
  const shown = useMemo(() => substituteDemoValues(code, values), [code, values]);
  const inputs = useMemo(() => inputFiles(code), [code]);

  const run = async (current: Readonly<Record<string, DemoValue>>): Promise<void> => {
    if (!supported) return;
    const generation = ++generationRef.current;
    const isCurrent = (): boolean => mountedRef.current && generation === generationRef.current;
    for (const url of urlsRef.current) URL.revokeObjectURL(url);
    urlsRef.current = [];
    const cold = !isAssimpLoaded();
    setOutcome({ kind: 'running', phase: cold ? 'load' : 'convert' });
    const createdUrls: string[] = [];
    try {
      const loadStarted = performance.now();
      const assimp = await loadAssimp();
      if (!isCurrent()) return;
      const loadMs = cold ? Math.round(performance.now() - loadStarted) : 0;
      const started = performance.now();
      const target = String(current['to'] ?? 'glb');
      if (!isDemoExportFormat(target)) throw new Error('Unsupported demo export format: '.concat(target));
      const exportOptions = demoExportOptions(current, target);
      const options = { to: target, exportOptions } satisfies ConvertOptions;
      const result = await assimp.convert(inputs, options);
      if (!isCurrent()) return;
      const ms = Math.round(performance.now() - started);

      const files = result.files.map((file) => {
        const mime = MIME[extension(file.name)] ?? 'application/octet-stream';
        const url = URL.createObjectURL(new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: mime }));
        createdUrls.push(url);
        return {
          bytes: file.bytes.byteLength,
          magic: magic(file.bytes),
          mime,
          name: file.name,
          url,
        };
      });
      urlsRef.current = createdUrls;
      setOutcome({
        files,
        inputBytes: inputs.reduce((sum, file) => sum + file.bytes.byteLength, 0),
        kind: 'done',
        loadMs,
        ms,
      });
    } catch (error: unknown) {
      for (const url of createdUrls) URL.revokeObjectURL(url);
      if (!isCurrent()) return;
      setOutcome({
        ...(error instanceof AssimpError ? { code: error.code } : {}),
        kind: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    void run(values);
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      for (const url of urlsRef.current) URL.revokeObjectURL(url);
      urlsRef.current = [];
    };
  }, []);

  const update = (key: string, value: DemoValue): void => {
    const next = { ...values, [key]: value };
    setValues(next);
    void run(next);
  };

  const done = outcome.kind === 'done' ? outcome : undefined;
  const totalOutput = done?.files.reduce((sum, file) => sum + file.bytes, 0) ?? 0;
  const target = String(values['to'] ?? 'glb');
  const quickLook = target === 'usdz' && done?.files.length === 1 && hasQuickLook();

  return (
    <div className={styles.demo} data-convert-demo>
      <DynamicCodeBlock code={shown} codeblock={codeblockProps} lang={lang} />

      <div className={styles.bench}>
        <section className={styles.fileRack} aria-label="Demo input files">
          <p className={styles.eyebrow}>Input</p>
          {inputs.map((file) => (
            <div className={styles.file} key={file.name}>
              <span className={styles.extension}>{extension(file.name)}</span>
              <span>
                <span className={styles.fileName}>{file.name}</span>
                <span className={styles.fileMeta}>{formatBytes(file.bytes.byteLength)}</span>
              </span>
            </div>
          ))}
        </section>

        <div className={styles.rail} aria-hidden="true">
          <span className={styles.arrow}>→</span>
          <strong>{target}</strong>
        </div>

        <section className={styles.fileRack} aria-label="Demo output files">
          <p className={styles.eyebrow}>Output</p>
          {done?.files.map((file) => (
            <div className={styles.file} key={file.name}>
              <span className={styles.extension}>{extension(file.name)}</span>
              <span>
                <span className={styles.fileName}>{file.name}</span>
                <span className={styles.fileMeta}>
                  {formatBytes(file.bytes)} · {file.magic}
                </span>
              </span>
            </div>
          )) ?? (
            <p className={styles.status}>
              {outcome.kind === 'failed' ? 'No artifact written' : 'Preparing artifact…'}
            </p>
          )}
        </section>
      </div>

      <dl className={styles.evidence} aria-label="Conversion evidence">
        <div className={styles.metric}>
          <dt>Convert</dt>
          <dd>{done ? `${done.ms} ms` : '—'}</dd>
        </div>
        <div className={styles.metric}>
          <dt>Output</dt>
          <dd>
            {done
              ? `${formatBytes(totalOutput)} · ${(totalOutput / done.inputBytes).toFixed(1)}× input`
              : '—'}
          </dd>
        </div>
        <div className={styles.metric}>
          <dt>Files</dt>
          <dd>{done ? `${inputs.length} → ${done.files.length}` : '—'}</dd>
        </div>
        <div className={styles.metric}>
          <dt>WASM load</dt>
          <dd>{done ? (done.loadMs > 0 ? `${done.loadMs} ms` : 'cached') : '—'}</dd>
        </div>
      </dl>

      <div className={styles.footer}>
        <div className={styles.controls}>
          {controls.map((control) => (
            <label className={styles.control} key={control.key}>
              <span>{control.label}</span>
              {control.kind === 'choice' ? (
                <select
                  disabled={outcome.kind === 'running'}
                  onChange={(event) => {
                    const choice = control.choices.find(
                      ({ value }) => String(value) === event.currentTarget.value,
                    );
                    if (choice) update(control.key, choice.value);
                  }}
                  value={String(values[control.key] ?? '')}
                >
                  {control.choices.map((choice) => (
                    <option key={String(choice.value)} value={String(choice.value)}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              ) : control.kind === 'range' ? (
                <input
                  disabled={outcome.kind === 'running'}
                  max={control.max}
                  min={control.min}
                  onChange={(event) => {
                    update(control.key, Number(event.currentTarget.value));
                  }}
                  step={control.step}
                  type="range"
                  value={Number(values[control.key] ?? control.min)}
                />
              ) : (
                <input
                  disabled={outcome.kind === 'running'}
                  onChange={(event) => {
                    update(control.key, event.currentTarget.value.slice(0, 64));
                  }}
                  type="text"
                  value={String(values[control.key] ?? '')}
                />
              )}
            </label>
          ))}
        </div>

        <div className={styles.actions}>
          {done?.files.map((file) => (
            <a className={styles.action} download={file.name} href={file.url} key={file.name}>
              Download {extension(file.name).toUpperCase()}
            </a>
          ))}
          {quickLook ? (
            <button
              className={styles.action}
              data-ar
              onClick={() => {
                launchQuickLook(done.files[0]?.url ?? '');
              }}
              type="button"
            >
              Open in AR
            </button>
          ) : undefined}
        </div>
      </div>

      {!supported ? <p className={styles.status}>This browser has no WebAssembly support.</p> : undefined}
      {outcome.kind === 'running' ? (
        <p className={styles.status}>{outcome.phase === 'load' ? 'Loading libassimp…' : 'Converting…'}</p>
      ) : undefined}
      {outcome.kind === 'failed' ? (
        <p className={`${styles.status} ${styles.error}`}>
          {outcome.code ? `${outcome.code}: ` : ''}
          {outcome.message}
        </p>
      ) : undefined}
      {target === 'usdz' && done && !quickLook ? (
        <p className={styles.status}>
          USDZ is ready to download. Open this page on an iPhone or iPad to launch Apple Quick Look.
        </p>
      ) : undefined}
    </div>
  );
};
