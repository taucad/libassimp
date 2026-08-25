import { describe, expect, it } from 'vitest';

import { averageBenchmarks, compareBenchmark } from '../scripts/compare-benchmark.mjs';

const report = (medianMs, initMs = 20) => ({
  name: 'cube-obj-to-glb-v1',
  medianMs,
  initMs,
  outputBytes: 2_360,
  outputFnv: '8d006812b6e519d6',
});

describe('benchmark comparison', () => {
  it('averages balanced same-runner samples before applying the unchanged gate', () => {
    const current = averageBenchmarks([report(1.4, 44), report(1, 40)]);
    const base = averageBenchmarks([report(1.3, 42), report(1.1, 38)]);
    expect(current).toMatchObject({ medianMs: 1.2, initMs: 42 });
    expect(compareBenchmark(current, base).failed).toBe(false);
  });

  it('refuses to average different output fingerprints', () => {
    expect(() => averageBenchmarks([report(1), { ...report(1), outputFnv: 'different' }])).toThrow(
      'different identities or output fingerprints',
    );
  });
});
