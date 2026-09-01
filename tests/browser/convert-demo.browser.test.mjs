import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('fumadocs-ui/components/dynamic-codeblock', () => ({
  DynamicCodeBlock: ({ code }) => createElement('pre', {}, code),
}));
vi.mock('@/lib/assimp-demo', () => ({
  hasQuickLook: () => false,
  hasWebAssembly: () => true,
  isAssimpLoaded: () => false,
  launchQuickLook: vi.fn(),
  loadAssimp: vi.fn(),
}));

import { ConvertDemo } from '../../docs-site/components/convert-demo';
import { loadAssimp } from '../../docs-site/lib/assimp-demo';

const code = `import { convert } from 'libassimp';
await convert({ name: 'cube.obj', bytes }, { to: 'glb' });`;
const output = (name) => ({ files: [{ name, bytes: new Uint8Array([1, 2, 3]) }] });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, reject, resolve };
};

let container;
let root;
let nextUrl;
let createObjectURL;
let revokeObjectURL;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  nextUrl = 0;
  createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:test-${++nextUrl}`);
  revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.mocked(loadAssimp).mockReset();
});

afterEach(async () => {
  if (root !== undefined) await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  vi.restoreAllMocks();
});

const render = async () => {
  await act(async () => root.render(createElement(ConvertDemo, { code })));
};

const unmount = async () => {
  await act(async () => root.unmount());
  root = undefined;
};

test.each(['load', 'convert'])('creates no object URL after unmount during deferred %s', async (phase) => {
  const pending = deferred();
  const convert = vi.fn(() =>
    phase === 'convert' ? pending.promise : Promise.resolve(output('result.glb')),
  );
  vi.mocked(loadAssimp).mockImplementation(() =>
    phase === 'load' ? pending.promise : Promise.resolve({ convert }),
  );
  await render();
  if (phase === 'convert') await vi.waitFor(() => expect(convert).toHaveBeenCalledOnce());
  await unmount();
  pending.resolve(phase === 'load' ? { convert } : output('result.glb'));
  await pending.promise;
  await Promise.resolve();
  expect(createObjectURL).not.toHaveBeenCalled();
});

test('revokes the previous output when its replacement fails', async () => {
  const convert = vi.fn().mockResolvedValueOnce(output('result.glb')).mockRejectedValueOnce(new Error('bad'));
  vi.mocked(loadAssimp).mockResolvedValue({ convert });
  await render();
  await vi.waitFor(() => expect(container.textContent).toContain('result.glb'));

  const select = container.querySelector('select');
  await act(async () => {
    select.value = 'stl';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await vi.waitFor(() => expect(container.textContent).toContain('bad'));
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-1');
});

test('does not let a stale conversion overwrite the latest result', async () => {
  const first = deferred();
  const second = deferred();
  const convert = vi.fn((_files, options) =>
    options.to === 'stl'
      ? first.promise
      : options.to === 'ply'
        ? second.promise
        : Promise.resolve(output('initial.glb')),
  );
  vi.mocked(loadAssimp).mockResolvedValue({ convert });
  await render();
  await vi.waitFor(() => expect(container.textContent).toContain('initial.glb'));

  const select = container.querySelector('select');
  await act(async () => {
    select.value = 'stl';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await vi.waitFor(() => expect(convert).toHaveBeenCalledTimes(2));
  await act(async () => {
    // Controls are normally disabled here; re-enable this one to exercise the generation guard directly.
    select.disabled = false;
    select.value = 'ply';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await vi.waitFor(() => expect(convert).toHaveBeenCalledTimes(3));
  await act(async () => second.resolve(output('latest.ply')));
  await vi.waitFor(() => expect(container.textContent).toContain('latest.ply'));
  await act(async () => {
    first.resolve(output('stale.stl'));
    await first.promise;
  });
  await Promise.resolve();
  expect(container.textContent).not.toContain('stale.stl');
  expect(createObjectURL).toHaveBeenCalledTimes(2);
});

test('revokes every current object URL on unmount', async () => {
  vi.mocked(loadAssimp).mockResolvedValue({
    convert: vi.fn().mockResolvedValue({
      files: [
        { name: 'result.gltf', bytes: new Uint8Array([1]) },
        { name: 'result.bin', bytes: new Uint8Array([2]) },
      ],
    }),
  });
  await render();
  await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(2));
  await unmount();
  expect(revokeObjectURL.mock.calls.map(([url]) => url)).toEqual(['blob:test-1', 'blob:test-2']);
});
