import { vi } from 'vitest';
import { createRequire } from 'node:module';

export const buildIdentity = `${process.platform}-${process.arch}-napi8`;
export const napiVersion = 8;
export const packageVersion = (createRequire(import.meta.url)('../../package.json') as { version: string })
  .version;
export const preparePlan = vi.fn(() => ({}));
export const runPlan = vi.fn(async () => 1);
export const cancelPlan = vi.fn();
export const takePlanResult = vi.fn(() => ({
  ok: true,
  code: '',
  message: '',
  formats: [{ format: 'glb', files: [] }],
}));
export const destroyPlan = vi.fn();
