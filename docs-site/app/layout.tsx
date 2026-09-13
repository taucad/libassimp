import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { RootProvider } from 'fumadocs-ui/provider/next';

import './global.css';

export const metadata: Metadata = {
  description:
    'Assimp for TypeScript and WebAssembly: import 69 3D formats and export 15 formats in browsers and Node.js.',
  icons: {
    // iOS masks the icon itself, so this one is full-bleed and opaque.
    apple: { sizes: '180x180', url: '/apple-touch-icon.png' },
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon.ico', sizes: '32x32' },
    ],
  },
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
