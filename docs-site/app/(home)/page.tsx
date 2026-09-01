import Link from 'next/link';

import { ConvertDemo } from '@/components/convert-demo';
import { SizeStrip } from '@/components/size-strip';

const homeDemo = `import { convert } from 'libassimp';

const response = await fetch('/cube.obj');
const bytes = new Uint8Array(await response.arrayBuffer());
const { files } = await convert({ name: 'cube.obj', bytes }, { to: 'glb' });

console.log(files[0].name, files[0].bytes.byteLength);`;

/** The home page: what the package does, what it costs to ship, and the way into the docs. */
const Page = (): React.JSX.Element => (
  <main className="mx-auto w-full max-w-5xl px-6 py-16">
    <div className="max-w-3xl">
      <p className="font-mono text-xs uppercase tracking-widest text-fd-muted-foreground">
        Assimp for JavaScript
      </p>
      <h1 className="mt-4 text-5xl font-semibold tracking-tight">Model in, model out.</h1>
      <p className="mt-5 text-lg text-fd-muted-foreground">
        libassimp reads 69 model-file extensions and writes 15 canonical formats, in Node.js, the browser and
        workers. Hand it the bytes of a model, name the format you want back, and it returns the converted
        bytes.
      </p>
    </div>

    <ConvertDemo code={homeDemo} />

    <div className="max-w-3xl">
      <SizeStrip />

      <p className="text-sm text-fd-muted-foreground">
        Brotli-compressed <code>libassimp.wasm</code>, plus the gzipped JavaScript entrypoint. One artifact
        provides the complete import and export catalog.
      </p>

      <div className="mt-8 flex flex-wrap gap-4 text-sm font-medium">
        <Link className="rounded-md border px-4 py-2 hover:bg-fd-accent" href="/docs">
          Read the documentation
        </Link>
        <Link className="rounded-md border px-4 py-2 hover:bg-fd-accent" href="/docs/tutorial">
          Convert a model in your browser
        </Link>
      </div>
    </div>
  </main>
);

export default Page;
