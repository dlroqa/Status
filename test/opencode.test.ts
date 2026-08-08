import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenCodeAdapter, classifyEntries } from '@main/providers/opencode';
import { AccountScope } from '@main/scope';
import type { Logger } from '@main/logger';

/**
 * These cases are built from OpenCode's own `src/auth/index.ts`, which stores a union
 * discriminated on `type`:
 *
 *   oauth     { refresh, access, expires, accountId?, enterpriseUrl? }
 *   api       { key, metadata? }
 *   wellknown { key, token }
 */

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

describe('classifyEntries', () => {
  it('reads an OAuth entry using the field names OpenCode actually writes', () => {
    const { subscriptions, keyOnlyProviders } = classifyEntries({
      anthropic: { type: 'oauth', access: 'token-value', refresh: 'r', expires: 1_800_000, accountId: 'acct-9' },
    });

    expect(keyOnlyProviders).toEqual([]);
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]).toMatchObject({
      providerKey: 'anthropic',
      accessToken: 'token-value',
      expires: 1_800_000,
      accountId: 'acct-9',
    });
  });

  it('separates API keys out, since this app tracks subscriptions only', () => {
    const { subscriptions, keyOnlyProviders } = classifyEntries({
      openai: { type: 'api', key: 'placeholder-value' },
      anthropic: { type: 'oauth', access: 'token' },
    });

    expect(keyOnlyProviders).toEqual(['openai']);
    expect(subscriptions.map((entry) => entry.providerKey)).toEqual(['anthropic']);
  });

  it('reports a wellknown entry rather than dropping it silently', () => {
    // This variant used to fall through the classifier entirely, so such a login neither
    // appeared nor was explained — the user saw nothing at all.
    const { subscriptions, keyOnlyProviders } = classifyEntries({
      'some-provider': { type: 'wellknown', key: 'k', token: 't' },
    });

    expect(subscriptions).toEqual([]);
    expect(keyOnlyProviders).toEqual(['some-provider']);
  });

  it('ignores entries it does not recognise instead of guessing at them', () => {
    const { subscriptions, keyOnlyProviders } = classifyEntries({
      mystery: { shape: 'unknown' },
      nothing: null,
    });
    expect(subscriptions).toEqual([]);
    expect(keyOnlyProviders).toEqual([]);
  });

  it('keeps an OAuth entry that carries no token, so it can still be reported', () => {
    const { subscriptions } = classifyEntries({ 'github-copilot': { type: 'oauth' } });
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]?.accessToken).toBeUndefined();
  });
});

describe('OpenCodeAdapter', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'opencode-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const probe = async () =>
    new OpenCodeAdapter().probe(new AccountScope(directory), { now: new Date(), logger: silentLogger });

  async function writeAuth(contents: unknown): Promise<void> {
    await writeFile(join(directory, 'auth.json'), JSON.stringify(contents), 'utf8');
  }

  it('derives identity from accountId, not from the directory path', async () => {
    // A path-derived id changes when the directory moves, which would silently turn one
    // account into another. accountId is the provider's own subject and survives that.
    await writeAuth({ 'github-copilot': { type: 'oauth', access: 'tok', accountId: 'acct-77' } });

    const result = await probe();
    expect(result.identity?.id).toBe('opencode:github-copilot:acct-77');
    expect(result.identity?.subject.accountUuid).toBe('acct-77');
  });

  it('falls back to a directory digest only when no accountId exists', async () => {
    await writeAuth({ 'github-copilot': { type: 'oauth', access: 'tok' } });

    const result = await probe();
    expect(result.identity?.id).toMatch(/^opencode:dir:[0-9a-f]{12}$/);
  });

  it('names the provider it found when its usage cannot be read', async () => {
    await writeAuth({ 'github-copilot': { type: 'oauth', access: 'tok', accountId: 'a' } });

    const measurement = (await probe()).windows['5h'];
    expect(measurement.state).toBe('unsupported');
    if (measurement.state !== 'unsupported') throw new Error('expected unsupported');
    expect(measurement.reason).toContain('GitHub Copilot');
  });

  it('says which providers were excluded for being API keys', async () => {
    await writeAuth({ openai: { type: 'api', key: 'placeholder-value' } });

    const measurement = (await probe()).windows['5h'];
    expect(measurement.state).toBe('not-connected');
    if (measurement.state !== 'not-connected') throw new Error('expected not-connected');
    expect(measurement.detail).toContain('ChatGPT Plus/Pro');
  });

  it('treats a missing auth file as simply not signed in', async () => {
    const measurement = (await probe()).windows['5h'];
    expect(measurement.state).toBe('not-connected');
    if (measurement.state !== 'not-connected') throw new Error('expected not-connected');
    expect(measurement.reason).toContain('no OpenCode logins');
  });

  it('separates a corrupt auth file from a missing one', async () => {
    await writeFile(join(directory, 'auth.json'), '{ not json', 'utf8');

    const measurement = (await probe()).windows['5h'];
    expect(measurement.state).toBe('error');
  });
});

describe('data directory resolution', () => {
  const original = process.env['XDG_DATA_HOME'];

  afterEach(() => {
    if (original === undefined) delete process.env['XDG_DATA_HOME'];
    else process.env['XDG_DATA_HOME'] = original;
  });

  it('honours XDG_DATA_HOME, which the installed CLI was confirmed to respect', () => {
    process.env['XDG_DATA_HOME'] = '/custom/data';
    expect(new OpenCodeAdapter().defaultConfigDirs()[0]).toBe('/custom/data/opencode');
  });

  it('falls back to the documented default', () => {
    delete process.env['XDG_DATA_HOME'];
    const dirs = new OpenCodeAdapter().defaultConfigDirs();
    expect(dirs.some((dir) => dir.includes('.local'))).toBe(true);
  });
});
