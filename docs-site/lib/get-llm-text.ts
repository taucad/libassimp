import { source } from '@/lib/source';

/** Absolute base for the Markdown projections agents fetch. */
const origin = 'https://libassimp.xyz';

export const getMarkdownPath = (pageUrl: string): string => `${pageUrl}.mdx`;

/**
 * Rewrite one Markdown link target to an absolute `.mdx` URL. Relative targets resolve against the
 * page they appear on, so `../api#converterror` on a guide becomes `/docs/api.mdx#converterror`.
 * Fragment-only and external targets are left alone.
 */
const absoluteMarkdownLink = (target: string, pageUrl: string): string => {
  if (/^(?:https?:|#)/u.test(target)) return target;
  const hash = target.indexOf('#');
  const path = hash === -1 ? target : target.slice(0, hash);
  const resolved = path.startsWith('/') ? path : new URL(path, `${origin}${pageUrl}`).pathname;
  if (!resolved.startsWith('/docs')) return target;
  return `${origin}${resolved}.mdx${hash === -1 ? '' : target.slice(hash)}`;
};

export const getLlmText = async (page: (typeof source)['$inferPage']): Promise<string> => {
  const processed = (await page.data.getText('processed'))
    .trim()
    .replaceAll(/\]\(([^)\s]*)\)/gu, (match, target: string) => {
      const rewritten = absoluteMarkdownLink(target, page.url);
      return rewritten === target ? match : `](${rewritten})`;
    });
  return `# ${page.data.title}\n\n${page.data.description}\n\nCanonical page: ${origin}${page.url}\n\n${processed}`;
};

export const markdownResponse = (body: string, status = 200): Response =>
  new Response(body, {
    status,
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
