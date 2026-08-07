import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountManager } from '@main/accounts';
import { ConfigStore } from '@main/config';
import type { Logger } from '@main/logger';
import type { ProbeResult, ProviderAdapter } from '@main/providers/types';
import { makeAccountId, type Provider } from '@shared/account';
import { allWindows, notConnected } from '@shared/window';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function stub(provider: Provider, probe: () => Promise<ProbeResult>, dirs: string[] = []): ProviderAdapter {
  return { provider, defaultConfigDirs: () => dirs, probe: async () => probe() };
}

function unconnected(provider: Provider): ProviderAdapter {
  return stub(provider, async () => ({ identity: null, windows: allWindows(notConnected('none')) }));
}

describe('AccountManager', () => {
  let directory: string;
  let store: ConfigStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'accounts-'));
    store = new ConfigStore(join(directory, 'config.json'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function managerWith(claude: ProviderAdapter): AccountManager {
    return new AccountManager(
      { claude, chatgpt: unconnected('chatgpt'), opencode: unconnected('opencode') },
      store,
      silentLogger,
    );
  }

  async function seedOne(): Promise<string> {
    const id = makeAccountId('claude', UUID_A);
    await store.save({
      version: 1,
      pollSeconds: 60,
      accounts: [{ id, provider: 'claude', label: 'Personal', configDir: directory }],
    });
    return id;
  }

  it('registers a newly signed-in account and skips ones already tracked', async () => {
    const identity = { id: makeAccountId('claude', UUID_A), subject: {}, label: 'Ed' };
    const manager = managerWith(
      stub('claude', async () => ({ identity, windows: allWindows(notConnected('x')) }), [directory]),
    );

    const first = await manager.detect();
    expect(first.added.map((a) => a.id)).toEqual([identity.id]);

    // Running it again must not create a duplicate row for the same account.
    const second = await manager.detect();
    expect(second.added).toEqual([]);
    expect(second.reason).toContain('already being tracked');
    expect(await manager.listAccounts()).toHaveLength(1);
  });

  it('explains itself when there is nothing signed in', async () => {
    const manager = managerWith(unconnected('claude'));
    const result = await manager.detect();
    expect(result.added).toEqual([]);
    expect(result.reason).toContain('No signed-in subscriptions');
  });

  it('renames an account without touching its identity', async () => {
    const id = await seedOne();
    const manager = managerWith(unconnected('claude'));

    expect((await manager.rename(id, '  Work  ')).ok).toBe(true);
    const [account] = await manager.listAccounts();
    expect(account?.label).toBe('Work');
    expect(account?.id).toBe(id);
  });

  it('refuses an empty name rather than saving a nameless row', async () => {
    const id = await seedOne();
    const manager = managerWith(unconnected('claude'));
    const result = await manager.rename(id, '   ');
    expect(result).toEqual({ ok: false, reason: 'A name cannot be empty.' });
  });

  it('sets and clears the monthly cap', async () => {
    const id = await seedOne();
    const manager = managerWith(unconnected('claude'));

    expect((await manager.setMonthlyCap(id, 2_000)).ok).toBe(true);
    expect((await manager.listAccounts())[0]?.monthlyCapMinor).toBe(2_000);

    expect((await manager.setMonthlyCap(id, null)).ok).toBe(true);
    expect((await manager.listAccounts())[0]?.monthlyCapMinor).toBeUndefined();
  });

  it('rejects a non-positive cap, which would make the bar meaningless', async () => {
    const id = await seedOne();
    const manager = managerWith(unconnected('claude'));
    expect((await manager.setMonthlyCap(id, 0)).ok).toBe(false);
    expect((await manager.setMonthlyCap(id, -5)).ok).toBe(false);
  });

  it('removes an account and reports that the CLI session is untouched', async () => {
    const id = await seedOne();
    const manager = managerWith(unconnected('claude'));

    const result = await manager.remove(id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.detail).toContain('left signed in');
    expect(await manager.listAccounts()).toEqual([]);
  });

  it('reports a clear reason for acting on an account that is gone', async () => {
    const manager = managerWith(unconnected('claude'));
    expect(await manager.rename('claude:missing', 'x')).toEqual({
      ok: false,
      reason: 'That account is no longer configured.',
    });
    expect((await manager.remove('claude:missing')).ok).toBe(false);
  });

  it('adds an account from a chosen folder', async () => {
    const identity = { id: makeAccountId('claude', UUID_B), subject: {}, label: 'Work Claude' };
    const manager = managerWith(stub('claude', async () => ({ identity, windows: allWindows(notConnected('x')) })));

    const result = await manager.addFromFolder('claude', directory);
    expect(result.ok).toBe(true);

    const [account] = await manager.listAccounts();
    expect(account?.id).toBe(identity.id);
    expect(account?.configDir).toBe(directory);
  });

  it('refuses a folder with no session instead of adding an unidentifiable row', async () => {
    const manager = managerWith(unconnected('claude'));
    const result = await manager.addFromFolder('claude', directory);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('No signed-in claude session');
  });

  it('refuses to add the same account twice from a different folder', async () => {
    const identity = { id: makeAccountId('claude', UUID_A), subject: {}, label: 'Ed' };
    const manager = managerWith(stub('claude', async () => ({ identity, windows: allWindows(notConnected('x')) })));

    expect((await manager.addFromFolder('claude', directory)).ok).toBe(true);
    const again = await manager.addFromFolder('claude', directory);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toContain('already being tracked');
  });

  it('contains an adapter that throws while probing a folder', async () => {
    const manager = managerWith(
      stub('claude', async () => {
        throw new Error('boom');
      }),
    );
    const result = await manager.addFromFolder('claude', directory);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('boom');
  });
});
