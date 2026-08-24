import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { RootProvider } from 'fumadocs-ui/provider/next';

import './global.css';

export const metadata: Metadata = {
  description:
    'Assimp compiled to WebAssembly: import 40+ 3D formats and export glTF, 3MF, USD, FBX, STL and more.',
  icons: {
    // iOS masks the icon itself, so this one is full-bleed and opaque.
    apple: { sizes: '180x180', url: '/apple-touch-icon.png' },
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon.ico', sizes: '32x32' },
    ],
  },
  metadataBase: new URL('https://libassimp.vercel.app'),
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
