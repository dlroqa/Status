import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Collector } from '@main/collector';
import { ConfigStore } from '@main/config';
import type { Logger } from '@main/logger';
import type { AccountScope } from '@main/scope';
import type { ProbeResult, ProviderAdapter } from '@main/providers/types';
import { makeAccountId, type Provider } from '@shared/account';
import { allWindows, live, notConnected, isLive } from '@shared/window';

const REAL_UUID = '11111111-1111-4111-8111-111111111111';
const OTHER_UUID = '22222222-2222-4222-8222-222222222222';

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** A stand-in adapter whose probe result the test controls exactly. */
function stubAdapter(provider: Provider, probe: () => Promise<ProbeResult>): ProviderAdapter {
  return {
    provider,
    defaultConfigDirs: () => [],
    probe: async (_scope: AccountScope) => probe(),
  };
}

function adapterSet(claude: ProviderAdapter): Readonly<Record<Provider, ProviderAdapter>> {
  const unusable = stubAdapter('chatgpt', async () => ({
    identity: null,
    windows: allWindows(notConnected('unused in this test')),
  }));
  return { claude, chatgpt: unusable, opencode: { ...unusable, provider: 'opencode' } };
}

function liveWindows(percent: number) {
  return allWindows(live({ percent, source: 'test', observedAt: '2026-08-07T18:00:00.000Z' }));
}

describe('Collector', () => {
  let directory: string;
  let store: ConfigStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'usage-monitor-'));
    store = new ConfigStore(join(directory, 'config.json'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function configureOneClaudeAccount(id: string): Promise<void> {
    await store.save({
      version: 1,
      pollSeconds: 60,
      accounts: [{ id, provider: 'claude', label: 'Ed — Claude Pro', configDir: directory }],
    });
  }

  it('reports usage for a matching account', async () => {
    const id = makeAccountId('claude', REAL_UUID);
    await configureOneClaudeAccount(id);

    const adapter = stubAdapter('claude', async () => ({
      identity: { id, subject: { accountUuid: REAL_UUID }, label: 'Ed', plan: 'Pro' },
      windows: liveWindows(2),
    }));

    const snapshot = await new Collector(adapterSet(adapter), store, silentLogger).collect();

    expect(snapshot.accounts).toHaveLength(1);
    const account = snapshot.accounts[0];
    expect(account?.accountId).toBe(id);
    expect(account?.plan).toBe('Pro');
    expect(isLive(account!.windows['5h'])).toBe(true);
  });

  it('refuses to show usage when the directory now holds a different account', async () => {
    // The registered account and the directory's actual login disagree — showing the new
    // account's numbers under the old row's name would be plausible and silently wrong.
    await configureOneClaudeAccount(makeAccountId('claude', REAL_UUID));

    const adapter = stubAdapter('claude', async () => ({
      identity: { id: makeAccountId('claude', OTHER_UUID), subject: {}, label: 'Someone Else' },
      windows: liveWindows(97),
    }));

    const snapshot = await new Collector(adapterSet(adapter), store, silentLogger).collect();
    const account = snapshot.accounts[0];

    expect(account?.accountId).toBe(makeAccountId('claude', REAL_UUID));
    for (const measurement of Object.values(account!.windows)) {
      expect(measurement.state).toBe('error');
      expect(isLive(measurement)).toBe(false);
      if (measurement.state !== 'error') throw new Error('expected error');
      expect(measurement.reason).toContain('different account');
      expect(measurement.detail).toContain('Someone Else');
    }
  });

  it('keeps the configured identity when the provider cannot confirm one', async () => {
    // Offline profile lookups must not orphan a row or silently re-key it.
    const id = makeAccountId('claude', REAL_UUID);
    await configureOneClaudeAccount(id);

    const adapter = stubAdapter('claude', async () => ({ identity: null, windows: liveWindows(11) }));
    const snapshot = await new Collector(adapterSet(adapter), store, silentLogger).collect();

    expect(snapshot.accounts[0]?.accountId).toBe(id);
    expect(isLive(snapshot.accounts[0]!.windows['5h'])).toBe(true);
  });

  it('contains a thrown adapter to its own row', async () => {
    await configureOneClaudeAccount(makeAccountId('claude', REAL_UUID));

    const adapter = stubAdapter('claude', async () => {
      throw new Error('adapter exploded');
    });

    const snapshot = await new Collector(adapterSet(adapter), store, silentLogger).collect();
    const measurement = snapshot.accounts[0]?.windows['5h'];

    expect(measurement?.state).toBe('error');
    if (measurement?.state !== 'error') throw new Error('expected error');
    expect(measurement.detail).toContain('adapter exploded');
  });

  it('surfaces a broken config file instead of silently showing nothing', async () => {
    await writeFile(join(directory, 'config.json'), '{ this is not json', 'utf8');

    const adapter = stubAdapter('claude', async () => ({ identity: null, windows: liveWindows(0) }));
    const snapshot = await new Collector(adapterSet(adapter), store, silentLogger).collect();

    expect(snapshot.configError).toBeDefined();
    expect(snapshot.accounts).toHaveLength(0);
  });

  it('keeps two accounts of one provider entirely separate', async () => {
    const first = makeAccountId('claude', REAL_UUID);
    const second = makeAccountId('claude', OTHER_UUID);
    await store.save({
      version: 1,
      pollSeconds: 60,
      accounts: [
        { id: first, provider: 'claude', label: 'Personal', configDir: directory },
        { id: second, provider: 'claude', label: 'Work', configDir: directory },
      ],
    });

    const percentByConfiguredId: Record<string, number> = { [first]: 12, [second]: 88 };
    let call = 0;
    const order = [first, second] as const;
    const adapter = stubAdapter('claude', async () => {
      const id = order[call++] as (typeof order)[number];
      return {
        identity: { id, subject: {}, label: id },
        windows: liveWindows(percentByConfiguredId[id] as number),
      };
    });

    const snapshot = await new Collector(adapterSet(adapter), store, silentLogger).collect();

    expect(snapshot.accounts.map((account) => account.accountId)).toEqual([first, second]);
    const percents = snapshot.accounts.map((account) => {
      const measurement = account.windows['5h'];
      return isLive(measurement) ? measurement.percent : null;
    });
    expect(percents).toEqual([12, 88]);
  });
});
