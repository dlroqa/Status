import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readCredentialsFile, readMacKeychainCredentials } from '@main/providers/credentials';
import { AccountScope } from '@main/scope';

describe('readCredentialsFile', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'creds-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('reads a session file inside the account scope', async () => {
    await writeFile(join(directory, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x' } }));
    const result = await readCredentialsFile(new AccountScope(directory), '.credentials.json');

    expect(result.found).toBe(true);
    if (!result.found) throw new Error('expected found');
    expect(result.source).toBe('.credentials.json');
  });

  it('reports a missing file as simply absent', async () => {
    const result = await readCredentialsFile(new AccountScope(directory), '.credentials.json');
    expect(result.found).toBe(false);
    if (result.found) throw new Error('expected absent');
    // No reason: "not signed in" is not an error to show the user as a failure.
    expect(result.reason).toBeUndefined();
  });

  it('separates a corrupt file from a missing one, because the fixes differ', async () => {
    await writeFile(join(directory, '.credentials.json'), '{ not json');
    const result = await readCredentialsFile(new AccountScope(directory), '.credentials.json');

    expect(result.found).toBe(false);
    if (result.found) throw new Error('expected absent');
    expect(result.reason).toContain('not valid JSON');
  });
});

describe('readMacKeychainCredentials', () => {
  it('is inert off macOS rather than shelling out', async () => {
    // Claude Code only uses the Keychain on darwin; elsewhere the file is the source.
    if (process.platform === 'darwin') return;
    const result = await readMacKeychainCredentials();
    expect(result.found).toBe(false);
    if (result.found) throw new Error('expected absent');
    expect(result.reason).toBeUndefined();
  });
});
