import { describe, expect, it } from 'vitest';
import { PROVIDERS } from '@shared/account';
import { installCommandFor } from '@main/installer';

describe('installCommandFor', () => {
  it('has an official command for every provider on every platform', () => {
    for (const provider of PROVIDERS) {
      for (const platform of ['darwin', 'linux', 'win32'] as NodeJS.Platform[]) {
        const command = installCommandFor(provider, platform);
        expect(command, `${provider} on ${platform}`).toBeDefined();
        expect(command?.display.length).toBeGreaterThan(0);
        expect(command?.documentation).toMatch(/^https:\/\//);
      }
    }
  });

  it('only ever downloads from the vendor that owns the product', () => {
    // A install command pointing anywhere but the vendor would be a supply-chain problem.
    const hosts: Record<string, RegExp> = {
      claude: /claude\.ai|@anthropic-ai/,
      chatgpt: /chatgpt\.com|@openai/,
      opencode: /opencode\.ai|opencode-ai/,
    };

    for (const provider of PROVIDERS) {
      for (const platform of ['darwin', 'linux', 'win32'] as NodeJS.Platform[]) {
        const command = installCommandFor(provider, platform);
        expect(command?.display, `${provider} on ${platform}`).toMatch(hosts[provider] as RegExp);
      }
    }
  });

  it('uses PowerShell on Windows and a shell elsewhere', () => {
    expect(installCommandFor('claude', 'win32')?.file).toBe('powershell.exe');
    expect(installCommandFor('claude', 'darwin')?.file).toBe('bash');
    expect(installCommandFor('claude', 'linux')?.file).toBe('bash');
  });

  it('never fetches over plain http', () => {
    for (const provider of PROVIDERS) {
      for (const platform of ['darwin', 'linux', 'win32'] as NodeJS.Platform[]) {
        expect(installCommandFor(provider, platform)?.display).not.toMatch(/http:\/\//);
      }
    }
  });
});
