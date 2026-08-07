import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InstallIdentity } from '@main/install-id';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('InstallIdentity', () => {
  let directory: string;
  let path: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'install-id-'));
    path = join(directory, 'install-id');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('creates a v4 UUID on first use', async () => {
    const value = await new InstallIdentity(path).read();
    expect(value).toMatch(UUID_V4);
  });

  it('is stable across restarts', async () => {
    const first = await new InstallIdentity(path).read();
    const second = await new InstallIdentity(path).read();
    expect(second).toBe(first);
  });

  it('is unique per installation', async () => {
    const a = await new InstallIdentity(path).read();
    const b = await new InstallIdentity(join(directory, 'other-id')).read();
    expect(b).not.toBe(a);
  });

  it('replaces a corrupt file rather than propagating it', async () => {
    await writeFile(path, 'not-a-uuid', 'utf8');
    const value = await new InstallIdentity(path).read();
    expect(value).toMatch(UUID_V4);
  });

  it('is written owner-only', async () => {
    await new InstallIdentity(path).read();
    const { mode } = await import('node:fs/promises').then((fs) => fs.stat(path));
    expect(mode & 0o777).toBe(0o600);
  });

  it('mints a new identity after removal, which is what a fresh install means', async () => {
    const identity = new InstallIdentity(path);
    const first = await identity.read();
    await identity.remove();

    await expect(readFile(path, 'utf8')).rejects.toThrow();
    expect(await identity.read()).not.toBe(first);
  });
});
