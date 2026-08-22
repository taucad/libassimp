import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

import packageManifest from '../../package.json';

/** Shared chrome, so the home page and the docs carry one nav, theme switch and source link. */
export const baseOptions: BaseLayoutProps = {
  githubUrl: 'https://github.com/taucad/libassimp',
  nav: { title: <span className="font-semibold tracking-tight">libassimp</span> },
};

/** Top-level links for the home page. The docs repeat these in their sidebar tree. */
export const homeLinks: BaseLayoutProps['links'] = [
  { text: 'Install', url: '/docs/install' },
  { text: 'Tutorial', url: '/docs/tutorial' },
  { text: 'API', url: '/docs/api' },
];

/** The published version, shown beside the docs nav title. */
export const packageVersion = packageManifest.version;
