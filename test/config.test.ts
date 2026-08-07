import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigStore } from '@main/config';
import { DEFAULT_POLL_SECONDS, MIN_POLL_SECONDS } from '@shared/config';

describe('ConfigStore', () => {
  let directory: string;
  let store: ConfigStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'config-'));
    store = new ConfigStore(join(directory, 'config.json'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('returns defaults with no error when the file does not exist yet', async () => {
    const result = await store.load();
    expect(result.error).toBeUndefined();
    expect(result.config.accounts).toEqual([]);
    expect(result.config.pollSeconds).toBe(DEFAULT_POLL_SECONDS);
  });

  it('round-trips a saved config', async () => {
    await store.save({
      version: 1,
      pollSeconds: 90,
      accounts: [{ id: 'claude:abc', provider: 'claude', label: 'Personal', configDir: '~/.claude' }],
    });

    const { config, error } = await store.load();
    expect(error).toBeUndefined();
    expect(config.pollSeconds).toBe(90);
    expect(config.accounts[0]?.label).toBe('Personal');
  });

  it('reports an unknown key rather than silently dropping it', async () => {
    // A silently ignored typo becomes a bar quietly watching the wrong thing.
    await writeFile(
      join(directory, 'config.json'),
      JSON.stringify({ version: 1, accounts: [], pollSecond: 60 }),
      'utf8',
    );

    const { error } = await store.load();
    expect(error).toBeDefined();
    expect(error).toContain('pollSecond');
  });

  it('rejects a poll interval below the floor that keeps the app polite to providers', async () => {
    await writeFile(
      join(directory, 'config.json'),
      JSON.stringify({ version: 1, pollSeconds: MIN_POLL_SECONDS - 1, accounts: [] }),
      'utf8',
    );

    const { error } = await store.load();
    expect(error).toBeDefined();
    expect(error).toContain('pollSeconds');
  });

  it('rejects an unknown provider', async () => {
    await writeFile(
      join(directory, 'config.json'),
      JSON.stringify({
        version: 1,
        accounts: [{ id: 'x:1', provider: 'gemini', label: 'x', configDir: '~/x' }],
      }),
      'utf8',
    );

    const { error } = await store.load();
    expect(error).toBeDefined();
  });

  it('reports malformed JSON without losing the defaults', async () => {
    await writeFile(join(directory, 'config.json'), '{ broken', 'utf8');
    const { config, error } = await store.load();
    expect(error).toContain('not valid JSON');
    expect(config.accounts).toEqual([]);
  });
});
