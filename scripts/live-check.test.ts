/**
 * Live verification against the real signed-in subscription on this machine.
 *
 * Excluded from the default suite (which is offline and deterministic) — run explicitly:
 *   pnpm exec vitest run --config scripts/vitest.live.config.ts --disableConsoleIntercept
 */
import { describe, expect, it } from 'vitest';
import { createLogger } from '@main/logger';
import { AccountScope } from '@main/scope';
import { createAdapters } from '@main/providers';
import { refreshSessionViaCli } from '@main/cli';
import { readCredentialsFile, readMacKeychainCredentials } from '@main/providers/credentials';
import { sessionStatus } from '@shared/session';
import { WINDOW_KINDS, isLive } from '@shared/window';
import { formatPercent, formatReset } from '@shared/format';
import { severityFor } from '@shared/severity';

const logger = createLogger('live');

describe('session status and refresh', () => {
  it('reads the session and reports how long it is good for', async () => {
    const scope = new AccountScope('~/.claude');
    const file = await readCredentialsFile(scope, '.credentials.json');
    const keychain = await readMacKeychainCredentials();

    console.log(`\n  credentials file : ${file.found ? 'present' : 'absent'}`);
    console.log(`  macOS keychain   : ${keychain.found ? 'present' : `absent${keychain.found ? '' : ''}`}`);

    const source = file.found ? file.value : keychain.found ? keychain.value : undefined;
    if (source === undefined) {
      console.log('  no Claude session on this machine — skipping');
      return;
    }

    const expiresAt = (source as { claudeAiOauth?: { expiresAt?: number } }).claudeAiOauth?.expiresAt;
    const status = sessionStatus(expiresAt, new Date());
    const hours = status.remainingMs === undefined ? undefined : (status.remainingMs / 3_600_000).toFixed(1);
    console.log(`  session state    : ${status.state}${hours === undefined ? '' : ` (${hours}h left)`}`);

    expect(['valid', 'expiring', 'expired', 'unknown']).toContain(status.state);
  }, 30_000);

  it('can ask the official client to refresh', async () => {
    const ran = await refreshSessionViaCli('claude', logger);
    console.log(`  refresh via client: ${ran ? 'ran' : 'client not available'}`);
    expect(typeof ran).toBe('boolean');
  }, 40_000);
});

describe('live subscription probe', () => {
  it('reads real windows for every provider', async () => {
    const adapters = createAdapters();
    const now = new Date();

    for (const adapter of Object.values(adapters)) {
      for (const dir of adapter.defaultConfigDirs()) {
        const scope = new AccountScope(dir, adapter.companionFiles?.(dir) ?? []);
        const result = await adapter.probe(scope, { now, logger });

        console.log(`\n=== ${adapter.provider} @ ${scope.root}`);
        console.log(`    identity: ${result.identity ? `${result.identity.label} (plan ${result.identity.plan ?? 'n/a'})` : 'none'}`);
        for (const kind of WINDOW_KINDS) {
          const m = result.windows[kind];
          if (isLive(m)) {
            const reset = m.resetsAt ? formatReset(m.resetsAt, now) : 'no reset reported';
            console.log(`    ${kind.padEnd(8)} LIVE ${formatPercent(m.percent).padStart(6)} ${severityFor(m.percent).padEnd(9)} ${reset}`);
          } else {
            console.log(`    ${kind.padEnd(8)} ${m.state.toUpperCase().padEnd(14)} ${m.reason}`);
          }
        }
      }
    }
    expect(true).toBe(true);
  }, 90_000);
});
