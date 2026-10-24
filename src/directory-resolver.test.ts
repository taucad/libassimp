import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDirectoryResolver } from './directory-resolver.js';

describe('createDirectoryResolver', () => {
  let root: string;
  let models: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'libassimp-resolver-'));
    models = join(root, 'models');
    await mkdir(join(models, 'textures'), { recursive: true });
    await writeFile(join(models, 'chair.mtl'), 'newmtl wood\n');
    await writeFile(join(models, 'textures', 'wood.png'), new Uint8Array([1, 2, 3]));
    await writeFile(join(root, 'secret.txt'), 'outside');
    await symlink(join(root, 'secret.txt'), join(models, 'escape.txt'));
    await symlink(join(models, 'chair.mtl'), join(models, 'alias.mtl'));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads names relative to the root with either separator', async () => {
    const resolve = createDirectoryResolver(models);
    expect(new TextDecoder().decode(await resolve('chair.mtl'))).toBe('newmtl wood\n');
    expect([...((await resolve('textures/wood.png')) ?? [])]).toEqual([1, 2, 3]);
    expect([...((await resolve('textures\\wood.png')) ?? [])]).toEqual([1, 2, 3]);
    expect([...((await resolve('textures/../textures/./wood.png')) ?? [])]).toEqual([1, 2, 3]);
    expect(await resolve('alias.mtl')).toBeInstanceOf(Uint8Array);
  });

  it('accepts a file: URL root', async () => {
    const resolve = createDirectoryResolver(pathToFileURL(`${models}/`));
    expect(await resolve('chair.mtl')).toBeInstanceOf(Uint8Array);
  });

  it.each([
    ['a parent escape', '../secret.txt'],
    ['a backslash parent escape', '..\\secret.txt'],
    ['an absolute POSIX path', '/etc/hostname'],
    ['a drive-letter path', 'C:\\secret.txt'],
    ['a NUL byte', 'chair.mtl\0.png'],
    ['a symbolic link out of the root', 'escape.txt'],
    ['a missing file', 'missing.png'],
    ['a directory', 'textures'],
    ['a path through a file', 'chair.mtl/inner.png'],
  ])('treats %s as missing', async (_label, name) => {
    await expect(createDirectoryResolver(models)(name)).resolves.toBeUndefined();
  });

  it('rejects on other I/O errors so the conversion reports RESOLVE_FAILED', async () => {
    vi.resetModules();
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>();
      return {
        ...actual,
        readFile: async () => Promise.reject(Object.assign(new Error('EIO: i/o error'), { code: 'EIO' })),
      };
    });
    try {
      const fresh = await import('./directory-resolver.js');
      await expect(fresh.createDirectoryResolver(models)('chair.mtl')).rejects.toMatchObject({ code: 'EIO' });
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });
});
