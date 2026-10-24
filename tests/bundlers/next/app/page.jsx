'use client';

import { useEffect } from 'react';

import { report } from '../../src/report.js';

export default function Page() {
  useEffect(() => {
    void report(async () => (await import('libassimp')).convert);
  }, []);
  return <p>libassimp next fixture</p>;
}
