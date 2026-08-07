/**
 * The menu-bar popover: every connected account at a glance.
 *
 * Rendered from the same `UsageSnapshot` the main window receives and built from the same
 * `AccountRow` and `UsageBar` components, so the two views cannot disagree about a number.
 */

import { useEffect, useState } from 'react';
import { ArrowUpRight, RefreshCw } from 'lucide-react';
import { formatAgo } from '@shared/format';
import type { AppInfo, UsageSnapshot } from '@shared/ipc';
import { selectMenuBarDisplay } from '@shared/menubar';
import { AccountRow } from './components/AccountRow';

const EMPTY: UsageSnapshot = {
  accounts: [],
  fetchedAt: new Date(0).toISOString(),
  refreshing: true,
};

export function Popover(): React.ReactElement {
  const [snapshot, setSnapshot] = useState<UsageSnapshot>(EMPTY);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const bridge = window.usageMonitor;
    void bridge.getSnapshot().then(setSnapshot);
    void bridge.getAppInfo().then(setAppInfo);
    return bridge.onSnapshot(setSnapshot);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const headline =
    appInfo === null ? undefined : selectMenuBarDisplay(snapshot.accounts, appInfo.menuBar);
  const fetchedAgo = formatAgo(snapshot.fetchedAt, now);

  return (
    <div className="popover">
      <header className="popover__head">
        <div>
          <div className="popover__title">{headline?.detail ?? 'AI Usage Monitor'}</div>
          <div className="popover__sub">
            {snapshot.refreshing ? 'refreshing…' : fetchedAgo !== undefined ? `updated ${fetchedAgo}` : ''}
          </div>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Refresh"
          onClick={() => void window.usageMonitor.refresh().then(setSnapshot)}
          disabled={snapshot.refreshing}
        >
          <RefreshCw size={13} className={snapshot.refreshing ? 'spin' : undefined} aria-hidden="true" />
        </button>
      </header>

      <div className="popover__body">
        {snapshot.accounts.length === 0 ? (
          <p className="popover__empty">
            No accounts connected yet. Open the app to sign in to a provider.
          </p>
        ) : (
          <div className="grid grid--popover">
            {snapshot.accounts.map((usage) => (
              <AccountRow key={usage.accountId} usage={usage} now={now} />
            ))}
          </div>
        )}
      </div>

      <footer className="popover__foot">
        <button type="button" className="button button--quiet" onClick={() => void window.usageMonitor.showMainWindow()}>
          <ArrowUpRight size={13} aria-hidden="true" /> Open AI Usage Monitor
        </button>
      </footer>
    </div>
  );
}
