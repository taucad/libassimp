import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { RootProvider } from 'fumadocs-ui/provider/next';

import './global.css';

export const metadata: Metadata = {
  description:
    'Assimp for TypeScript and WebAssembly: import 69 3D formats and export 15 formats in browsers and Node.js.',
  metadataBase: new URL('https://libassimp.xyz'),
  title: { default: 'libassimp', template: `%s — libassimp` },
};

const Layout = ({ children }: { readonly children: ReactNode }): React.JSX.Element => (
  <html lang="en" suppressHydrationWarning>
    <body className="flex min-h-screen flex-col">
      <RootProvider>{children}</RootProvider>
    </body>
  </html>
);

export default Layout;
