'use client';

import { useState } from 'react';

import { hasWebAssembly, loadAssimp } from '@/lib/assimp-demo';

/** A cube with a material library beside it: the smallest model that needs a sidecar file. */
const CUBE_OBJ = `mtllib cube.mtl
usemtl shell
v -1 -1 -1
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

const CUBE_MTL = `newmtl shell
Kd 0.72 0.36 0.18
Ks 0.1 0.1 0.1
Ns 32
`;

type Outcome =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running' }
  | { readonly kind: 'done'; readonly name: string; readonly bytes: number; readonly ms: number }
  | { readonly kind: 'failed'; readonly message: string };

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * Run the page's own conversion in the reader's browser: the cube and its material library go in,
 * a GLB comes out, and the panel reports what the call produced.
 *
 * The example beside it stays the source of truth for the code; this runs the same conversion
 * through the importer build served from `/demo/`.
 */
export const ConvertDemo = ({
  children,
}: {
  /** The fenced example, which renders above the panel and carries into the Markdown projection. */
  readonly children?: React.ReactNode;
  readonly code?: string;
  readonly lang?: string;
}): React.JSX.Element => {
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  const supported = hasWebAssembly();

  const run = async (): Promise<void> => {
    setOutcome({ kind: 'running' });
    let assimp;
    try {
      assimp = await loadAssimp();
    } catch {
      // A build without the binaries beside it still ships the page; say so rather than
      // surfacing a bare module-resolution error.
      setOutcome({ kind: 'failed', message: 'the importer build could not be loaded from /demo/' });
      return;
    }

    try {
      const files = [
        { name: 'cube.obj', bytes: encode(CUBE_OBJ) },
        { name: 'cube.mtl', bytes: encode(CUBE_MTL) },
      ];
      const started = performance.now();
      const result = assimp.convert('cube.obj', files, 'glb', {}, undefined);
      const ms = Math.round(performance.now() - started);
      if (!result.ok) {
        setOutcome({ kind: 'failed', message: `${result.code}: ${result.message}` });
        return;
      }
      const primary = result.files.at(0);
      setOutcome(
        primary
          ? { kind: 'done', name: primary.name, bytes: primary.bytes.byteLength, ms }
          : { kind: 'failed', message: 'the conversion returned no files' },
      );
    } catch (error: unknown) {
      setOutcome({ kind: 'failed', message: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <div className="my-6 rounded-xl border bg-fd-card">
      {children}
      <div className="flex flex-wrap items-center gap-3 border-t px-4 py-3 text-sm not-prose">
        <button
          className="rounded-md border px-3 py-1 font-medium transition-colors hover:bg-fd-accent disabled:opacity-50"
          disabled={!supported || outcome.kind === 'running'}
          onClick={() => {
            void run();
          }}
          type="button"
        >
          {outcome.kind === 'running' ? 'Converting…' : 'Run the conversion'}
        </button>
        <output className="font-mono text-xs text-fd-muted-foreground" data-testid="convert-demo-output">
          {!supported && 'This host has no WebAssembly, so the conversion cannot run here.'}
          {supported && outcome.kind === 'idle' && 'Converts cube.obj plus cube.mtl to GLB, in this tab.'}
          {outcome.kind === 'running' && 'Loading the importer build (about 10 MB) and converting…'}
          {outcome.kind === 'done' &&
            `${outcome.name} — ${outcome.bytes.toLocaleString('en-US')} bytes in ${outcome.ms} ms`}
          {outcome.kind === 'failed' && `failed: ${outcome.message}`}
        </output>
      </div>
    </div>
  );
};
