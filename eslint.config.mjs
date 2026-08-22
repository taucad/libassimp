import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import { plugin } from './tools/eslint-plugin/index.js';

export default tseslint.config(
  {
    ignores: [
      'assimp/**',
      'build/**',
      'coverage/**',
      'dist/**',
      'docs-site/.next/**',
      'docs-site/.source/**',
      'docs-site/public/demo/**',
      'docs-site/out/**',
      'node_modules/**',
      'src/wasm/**',
    ],
  },
  eslint.configs.recommended,
  {
    files: ['**/*.{cjs,js,mjs}'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['tests/browser/**/*.mjs'],
    languageOptions: { globals: { ...globals.browser, ...globals.worker } },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: tseslint.configs.strictTypeChecked,
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test-d.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/only-throw-error': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    files: ['**/*.{cjs,js,mjs,ts,tsx}'],
    plugins: { libassimp: plugin },
    rules: { 'libassimp/jsdoc-quality': 'error' },
  },
);
