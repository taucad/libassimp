import { jsdocQualityRule } from './jsdoc-quality.js';

export const plugin = {
  meta: { name: 'libassimp', version: '1.0.0' },
  rules: { 'jsdoc-quality': jsdocQualityRule },
};
