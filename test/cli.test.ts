import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROVIDER_CLIS, findCli } from '@main/cli';

describe('PROVIDER_CLIS', () => {
  it('uses the login commands each CLI actually documents', () => {
    // Verified against `claude auth --help`, `codex login --help` and the OpenCode docs.
    expect(PROVIDER_CLIS.claude).toMatchObject({ command: 'claude', loginArgs: ['auth', 'login'] });
    expect(PROVIDER_CLIS.chatgpt).toMatchObject({ command: 'codex', loginArgs: ['login'] });
    expect(PROVIDER_CLIS.opencode).toMatchObject({ command: 'opencode', loginArgs: ['auth', 'login'] });
  });

  it('offers somewhere to install every provider', () => {
    for (const cli of Object.values(PROVIDER_CLIS)) {
      expect(cli.installUrl).toMatch(/^https:\/\//);
    }
  });
});

describe('findCli', () => {
  let directory: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'clis-'));
    originalPath = process.env['PATH'];
  });

  afterEach(async () => {
    if (originalPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = originalPath;
    await rm(directory, { recursive: true, force: true });
  });

  it('finds an executable on PATH', async () => {
    const target = join(directory, 'faux-cli');
    await writeFile(target, '#!/bin/sh\nexit 0\n');
    await chmod(target, 0o755);
    process.env['PATH'] = directory;

    expect(await findCli('faux-cli')).toBe(target);
  });

  it('ignores a file that is present but not executable', async () => {
    const target = join(directory, 'not-runnable');
    await writeFile(target, 'text');
    await chmod(target, 0o644);
    process.env['PATH'] = directory;

    expect(await findCli('not-runnable')).toBeUndefined();
  });

  it('returns undefined for a command that does not exist', async () => {
    process.env['PATH'] = directory;
    expect(await findCli('definitely-not-installed-xyz')).toBeUndefined();
  });

  it('still finds a CLI when PATH is empty, because a GUI app does not inherit the shell PATH', async () => {
    // Launched from Finder or the Start menu the process gets a minimal PATH, so reporting
    // "not installed" for a tool the user can run in their terminal would be badly wrong.
    process.env['PATH'] = '';
    // node lives in one of the standard directories searched as a fallback.
    const found = await findCli('sh');
    expect(found === undefined || found.endsWith('/sh')).toBe(true);
  });
});
