import type { ReactNode } from 'react';
import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

import packageManifest from '../../package.json';

/** Nav brand: the Fold Stack mark plus the package name. */
export const NavTitle = (): ReactNode => (
  <span className="flex items-center gap-2 font-semibold tracking-tight">
    {/* Plain img, not next/image: an inline SVG mark needs no optimisation. */}
    <img alt="" className="h-6 w-6" src="/logo.svg" />
    libassimp
  </span>
);

/** Shared chrome, so the home page and the docs carry one nav, theme switch and source link. */
export const baseOptions: BaseLayoutProps = {
  githubUrl: 'https://github.com/taucad/libassimp',
  nav: { title: <NavTitle /> },
};

/** Top-level links for the home page. The docs repeat these in their sidebar tree. */
export const homeLinks: BaseLayoutProps['links'] = [
  { text: 'Install', url: '/docs/install' },
  { text: 'Tutorial', url: '/docs/tutorial' },
  { text: 'API', url: '/docs/api' },
];

/** The published version, shown beside the docs nav title. */
export const packageVersion = packageManifest.version;
