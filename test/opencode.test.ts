import { describe, expect, it } from 'vitest';
import { classifyEntries } from '@main/providers/opencode';

describe('classifyEntries', () => {
  it('recognises an OAuth subscription entry and its token', () => {
    const { subscriptions, apiKeyProviders } = classifyEntries({
      anthropic: { type: 'oauth', access: 'token-value', refresh: 'r', expires: 1 },
    });

    expect(apiKeyProviders).toEqual([]);
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]?.providerKey).toBe('anthropic');
    expect(subscriptions[0]?.accessToken).toBe('token-value');
  });

  it('accepts the alternative access_token spelling used by some versions', () => {
    const { subscriptions } = classifyEntries({ anthropic: { type: 'oauth', access_token: 'alt' } });
    expect(subscriptions[0]?.accessToken).toBe('alt');
  });

  it('separates API keys out, since this app tracks subscriptions only', () => {
    const { subscriptions, apiKeyProviders } = classifyEntries({
      openai: { type: 'api', key: 'sk-should-never-be-used' },
      anthropic: { type: 'oauth', access: 'token' },
    });

    expect(apiKeyProviders).toEqual(['openai']);
    expect(subscriptions.map((entry) => entry.providerKey)).toEqual(['anthropic']);
  });

  it('ignores entries it does not recognise instead of guessing at them', () => {
    const { subscriptions, apiKeyProviders } = classifyEntries({
      mystery: { shape: 'unknown' },
      nothing: null,
    });
    expect(subscriptions).toEqual([]);
    expect(apiKeyProviders).toEqual([]);
  });

  it('keeps an OAuth entry that carries no token, so it can still be reported', () => {
    const { subscriptions } = classifyEntries({ 'github-copilot': { type: 'oauth' } });
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]?.accessToken).toBeUndefined();
  });
});
