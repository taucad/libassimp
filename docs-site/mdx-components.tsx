import defaultMdxComponents from 'fumadocs-ui/mdx';
import { TypeTable } from 'fumadocs-ui/components/type-table';
import type { MDXComponents } from 'mdx/types';

import { ConvertDemo } from '@/components/convert-demo';
import { ExportMatrix, ImportMatrix } from '@/components/format-matrix';
import { Mermaid } from '@/components/mermaid';
import { SizeStrip } from '@/components/size-strip';

export const getMDXComponents = (components?: MDXComponents): MDXComponents => ({
  ...defaultMdxComponents,
  ConvertDemo,
  ExportMatrix,
  ImportMatrix,
  Mermaid,
  SizeStrip,
  TypeTable,
  ...components,
});
