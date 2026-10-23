import { describe, expect, it } from 'vitest';

import { compareBaselines, foldReports } from '../scripts/compare-baselines.mjs';
import { recordBaselines } from '../scripts/record-baselines.mjs';

const outputs = [{ name: 'result.usdz', bytes: 1000, fnv: 'abc' }];
const sample = (overrides = {}) => ({
  medianMs: 100,
  calibrationMs: 10,
  ratio: 10,
  memoryBytes: 64 * 1024 * 1024,
  maxRssBytes: 200 * 1024 * 1024,
  inputBytes: 10,
  outputs,
  ...overrides,
});
const report = (wasm = {}, native = {}) => ({
  name: 'usd-v1',
  platform: 'linux-x64',
  node: 'v26.0.0',
  workloads: {
    'usda-grid-to-usdz': { wasm: sample(wasm), native: sample({ memoryBytes: undefined, ...native }) },
  },
});
const empty = {
  name: 'usd-v1',
  tolerance: {
    ratio: 0.15,
    memoryBytes: { relative: 0.02, absolute: 1024 * 1024 },
    maxRssBytes: { relative: 0.1, absolute: 8 * 1024 * 1024 },
  },
  platforms: {},
};
const recorded = recordBaselines(empty, foldReports([report()]), 'unit test');

describe('compareBaselines', () => {
  it('admits an unrecorded platform without failing', () => {
    const result = compareBaselines(report(), empty);
    expect(result.failed).toBe(false);
    expect(result.markdown).toContain('No baselines recorded');
  });

  it('passes a report equal to its baselines', () => {
    expect(compareBaselines(report(), recorded).failed).toBe(false);
  });

  it('fails a time ratio beyond tolerance and notes an improvement', () => {
    expect(compareBaselines(report({ ratio: 11.6 }), recorded).failures).toEqual([
      expect.stringContaining('usda-grid-to-usdz/wasm time ratio 11.6'),
    ]);
    expect(compareBaselines(report({ ratio: 11.4 }), recorded).failed).toBe(false);
    expect(compareBaselines(report({ ratio: 5 }), recorded).markdown).toContain('ratchet');
  });

  it('fails Wasm memory or RSS growth beyond tolerance', () => {
    const memory = 64 * 1024 * 1024;
    expect(compareBaselines(report({ memoryBytes: memory + 1024 * 1024 }), recorded).failed).toBe(false);
    expect(
      compareBaselines(report({ memoryBytes: Math.ceil(memory * 1.03) }), recorded).failures[0],
    ).toContain('Wasm memory');
    expect(compareBaselines(report({}, { maxRssBytes: 240 * 1024 * 1024 }), recorded).failures[0]).toContain(
      'peak RSS',
    );
  });

  it('fails changed fingerprints, lost workloads and skipped workloads', () => {
    expect(
      compareBaselines(report({ outputs: [{ ...outputs[0], fnv: 'def' }] }), recorded).failures[0],
    ).toContain('fingerprints changed');
    const lost = report();
    delete lost.workloads['usda-grid-to-usdz'].native;
    expect(compareBaselines(lost, recorded).failures[0]).toContain('was not measured');
    const skipped = report();
    skipped.workloads['usda-grid-to-usdz'].wasm = { skipped: 'export usdz unavailable' };
    expect(compareBaselines(skipped, recorded).failures[0]).toContain('was skipped');
  });
});

describe('foldReports', () => {
  it('keeps the best ratio and the worst memory', () => {
    const folded = foldReports([
      report({ ratio: 12, memoryBytes: 10 }),
      report({ ratio: 9, memoryBytes: 20 }),
    ]);
    expect(folded.workloads['usda-grid-to-usdz'].wasm).toMatchObject({ ratio: 9, memoryBytes: 20 });
  });

  it('rejects nondeterministic outputs', () => {
    expect(() => foldReports([report(), report({ outputs: [{ ...outputs[0], bytes: 1 }] })])).toThrow(
      'not deterministic',
    );
  });
});

describe('recordBaselines', () => {
  it('requires an origin and records per platform', () => {
    expect(() => recordBaselines(empty, foldReports([report()]), ' ')).toThrow('--origin');
    expect(recorded.platforms['linux-x64'].origin).toBe('unit test (Node v26.0.0)');
    expect(recorded.platforms['linux-x64'].workloads['usda-grid-to-usdz'].native).not.toHaveProperty(
      'memoryBytes',
    );
  });
});
