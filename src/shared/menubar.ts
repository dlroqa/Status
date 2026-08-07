/**
 * What the menu-bar item shows.
 *
 * Pure and shared by the tray and the popover so the two can never disagree, and so the
 * selection rules are testable without a running app.
 */

import type { AccountId, AccountUsage } from './account';
import { formatPercent } from './format';
import { severityFor, type Severity } from './severity';
import { isLive, WINDOW_LABELS, type WindowKind } from './window';

export const MENU_BAR_SOURCES = ['closest', 'chosen'] as const;
export type MenuBarSource = (typeof MENU_BAR_SOURCES)[number];

export interface MenuBarSetting {
  readonly source: MenuBarSource;
  /**
   * Which account to show in `chosen` mode.
   *
   * Typed as a plain string, not `AccountId`, because it is read from a user-editable
   * config file and may name an account that has since been removed. It is validated by
   * looking it up rather than by asserting its shape — a cast would only move the failure.
   */
  readonly accountId?: string | undefined;
}

export interface MenuBarDisplay {
  /** The text next to the icon, e.g. "45%" — or "—" when there is no reading. */
  readonly title: string;
  /** Drives the icon colour. Undefined when nothing is measurable. */
  readonly severity: Severity | undefined;
  /** Tooltip / popover heading, e.g. "Ed — 5-hour". */
  readonly detail: string;
  /** The account the figure came from, so the popover can point at it. */
  readonly accountId?: AccountId;
  readonly windowKind?: WindowKind;
}

const NOTHING: MenuBarDisplay = {
  title: '—',
  severity: undefined,
  detail: 'No accounts connected',
};

/**
 * Picks the figure to display.
 *
 * A non-live account never contributes a number. Showing `0%` for an account that is
 * rate-limited or signed out would read as "plenty left" when the truth is "no reading" —
 * the same reason an unmeasurable bar is hatched rather than empty.
 */
export function selectMenuBarDisplay(
  accounts: readonly AccountUsage[],
  setting: MenuBarSetting,
): MenuBarDisplay {
  if (accounts.length === 0) return NOTHING;

  if (setting.source === 'chosen') {
    const chosen =
      accounts.find((account) => account.accountId === setting.accountId) ?? accounts[0];
    if (chosen === undefined) return NOTHING;

    const measurement = chosen.windows['5h'];
    if (!isLive(measurement)) {
      return {
        title: '—',
        severity: undefined,
        detail: `${chosen.label} — ${measurement.reason}`,
        accountId: chosen.accountId,
        windowKind: '5h',
      };
    }
    return {
      title: formatPercent(measurement.percent),
      severity: severityFor(measurement.percent),
      detail: `${chosen.label} — ${WINDOW_LABELS['5h']}`,
      accountId: chosen.accountId,
      windowKind: '5h',
    };
  }

  // `closest`: the highest live reading across every account and window, so the number on
  // screen is the one that will run out first.
  let best: { account: AccountUsage; kind: WindowKind; percent: number } | undefined;

  for (const account of accounts) {
    for (const kind of Object.keys(account.windows) as WindowKind[]) {
      const measurement = account.windows[kind];
      if (!isLive(measurement)) continue;
      if (best === undefined || measurement.percent > best.percent) {
        best = { account, kind, percent: measurement.percent };
      }
    }
  }

  if (best === undefined) {
    // Connected accounts exist but nothing is readable right now.
    const first = accounts[0];
    return {
      title: '—',
      severity: undefined,
      detail:
        accounts.length === 1 && first !== undefined
          ? `${first.label} — no reading`
          : 'No readings available',
      ...(first === undefined ? {} : { accountId: first.accountId }),
    };
  }

  return {
    title: formatPercent(best.percent),
    severity: severityFor(best.percent),
    detail: `${best.account.label} — ${WINDOW_LABELS[best.kind]}`,
    accountId: best.account.accountId,
    windowKind: best.kind,
  };
}
