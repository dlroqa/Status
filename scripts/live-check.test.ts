/**
 * Live verification against the real signed-in subscription on this machine.
 *
 * Excluded from the default suite (which is offline and deterministic) — run explicitly:
 *   pnpm exec vitest run --include 'scripts/*.test.ts'
 */
import { describe, expect, it } from 'vitest';
import { createLogger } from '@main/logger';
import { AccountScope } from '@main/scope';
import { createAdapters } from '@main/providers';
import { discoverAccounts } from '@main/discovery';
import { WINDOW_KINDS, isLive } from '@shared/window';
import { formatPercent, formatReset } from '@shared/format';
import { severityFor } from '@shared/severity';

const logger = createLogger('live');

describe('live subscription probe', () => {
  it('reads real windows for every provider', async () => {
    const adapters = createAdapters();
    const now = new Date();

    for (const adapter of Object.values(adapters)) {
      for (const dir of adapter.defaultConfigDirs()) {
        const scope = new AccountScope(dir, adapter.companionFiles?.(dir) ?? []);
        const result = await adapter.probe(scope, { now, logger });

        console.log(`\n=== ${adapter.provider} @ ${scope.root}`);
        console.log(`    identity: ${result.identity ? `${result.identity.id} (${result.identity.label}, plan ${result.identity.plan ?? 'n/a'})` : 'none'}`);
        for (const kind of WINDOW_KINDS) {
          const m = result.windows[kind];
          if (isLive(m)) {
            const reset = m.resetsAt ? formatReset(m.resetsAt, now) : 'no reset reported';
            console.log(`    ${kind.padEnd(8)} LIVE  ${formatPercent(m.percent).padStart(6)}  ${severityFor(m.percent).padEnd(9)} ${reset}${m.detail ? ` · ${m.detail}` : ''}`);
          } else {
            console.log(`    ${kind.padEnd(8)} ${m.state.toUpperCase().padEnd(14)} ${m.reason}${m.detail ? ` — ${m.detail}` : ''}`);
          }
        }
      }
    }

    const discovered = await discoverAccounts(adapters, logger, now);
    console.log('\n=== discovered accounts:', JSON.stringify(discovered, null, 2));
    expect(Array.isArray(discovered)).toBe(true);
  }, 60_000);
});
