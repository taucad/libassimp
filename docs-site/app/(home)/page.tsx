import Link from 'next/link';

import { SizeStrip } from '@/components/size-strip';

/** The home page: what the package does, what it costs to ship, and the way into the docs. */
const Page = (): React.JSX.Element => (
  <main className="mx-auto w-full max-w-3xl px-6 py-16">
    <p className="font-mono text-xs uppercase tracking-widest text-fd-muted-foreground">
      Assimp for JavaScript
    </p>
    <h1 className="mt-4 text-5xl font-semibold tracking-tight">Model in, model out.</h1>
    <p className="mt-5 text-lg text-fd-muted-foreground">
      libassimp reads 44 model formats and writes 21, in Node.js, the browser and workers. Hand it the bytes
      of a model, name the format you want back, and it returns the converted bytes.
    </p>

    <SizeStrip />

    <p className="text-sm text-fd-muted-foreground">
      Brotli-compressed binary per entry, plus the gzipped JavaScript entrypoint. Import the narrowest entry
      that covers the conversion and ship the smallest binary.
    </p>

    <div className="mt-8 flex flex-wrap gap-4 text-sm font-medium">
      <Link className="rounded-md border px-4 py-2 hover:bg-fd-accent" href="/docs">
        Read the documentation
      </Link>
      <Link className="rounded-md border px-4 py-2 hover:bg-fd-accent" href="/docs/tutorial">
        Convert a model in your browser
      </Link>
    </div>
  </main>
);

export default Page;
