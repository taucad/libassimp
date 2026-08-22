import Link from 'next/link';

const Page = (): React.JSX.Element => (
  <main className="mx-auto max-w-3xl px-6 py-20">
    <p className="text-sm text-fd-muted-foreground">Part of the Tau ecosystem</p>
    <h1 className="mt-3 text-5xl font-semibold">libassimp</h1>
    <p className="mt-5 text-lg text-fd-muted-foreground">
      Assimp compiled to WebAssembly: import 40+ 3D formats and export glTF, 3MF, USD, FBX, STL and more.
    </p>
    <Link className="mt-8 inline-block text-fd-primary underline" href="/docs">
      Read the documentation
    </Link>
  </main>
);

export default Page;
