import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Settings2, UserPlus } from 'lucide-react';
import type { AccountUsage } from '@shared/account';
import { formatAgo } from '@shared/format';
import type { AppInfo, UsageSnapshot } from '@shared/ipc';
import { AccountRow } from './components/AccountRow';
import { AccountsPanel } from './components/AccountsPanel';

const EMPTY_SNAPSHOT: UsageSnapshot = {
  accounts: [],
  fetchedAt: new Date(0).toISOString(),
  refreshing: true,
};

export function App(): React.ReactElement {
  const [snapshot, setSnapshot] = useState<UsageSnapshot>(EMPTY_SNAPSHOT);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [accountsOpen, setAccountsOpen] = useState(false);
  // Reset times count down, so the view needs its own clock rather than only re-rendering on new data.
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

  const refresh = useCallback(() => {
    void window.usageMonitor.refresh().then(setSnapshot);
  }, []);

  const labelsById = useMemo(
    () => new Map(snapshot.accounts.map((account) => [account.accountId, account.label])),
    [snapshot.accounts],
  );

  const fetchedAgo = formatAgo(snapshot.fetchedAt, now);
  const hasLoaded = snapshot.fetchedAt !== EMPTY_SNAPSHOT.fetchedAt;

  return (
    <div className="app">
      <header className="toolbar">
        <h1 className="toolbar__title">AI Usage Monitor</h1>
        <div className="toolbar__spacer" />
        <span className="toolbar__status" aria-live="polite">
          {snapshot.refreshing ? 'refreshing…' : hasLoaded && fetchedAgo !== undefined ? `updated ${fetchedAgo}` : ''}
        </span>
        <button type="button" onClick={refresh} disabled={snapshot.refreshing}>
          <RefreshCw size={13} className={snapshot.refreshing ? 'spin' : undefined} aria-hidden="true" />
          Refresh
        </button>
      </header>

      {snapshot.configError !== undefined && (
        <div className="notice" role="alert">
          <strong>Configuration problem.</strong> {snapshot.configError}
        </div>
      )}

      <div className="scroll">
        {snapshot.accounts.length === 0 ? (
          <EmptyState loaded={hasLoaded} onOpenAccounts={() => setAccountsOpen(true)} />
        ) : (
          <div className="grid">
            <div className="grid__head">
              <div>Account</div>
              <div>Window</div>
            </div>
            {snapshot.accounts.map((usage) => (
              <AccountRow
                key={usage.accountId}
                usage={usage}
                now={now}
                {...poolPartner(usage, labelsById)}
              />
            ))}
          </div>
        )}
      </div>

      <footer className="footer">
        <span>v{appInfo?.version ?? '—'}</span>
        {appInfo !== null && <span>polling every {appInfo.pollSeconds}s</span>}
        <div className="toolbar__spacer" />
        <button type="button" onClick={() => setAccountsOpen(true)}>
          <Settings2 size={12} aria-hidden="true" /> Manage accounts
        </button>
      </footer>

      {accountsOpen && (
        <AccountsPanel onClose={() => setAccountsOpen(false)} configPath={appInfo?.configPath} />
      )}
    </div>
  );
}

/** Only claims a shared pool when the partner account is actually on screen. */
function poolPartner(
  usage: AccountUsage,
  labelsById: ReadonlyMap<string, string>,
): { poolPartnerLabel?: string } {
  if (usage.sharesPoolWith === undefined) return {};
  const label = labelsById.get(usage.sharesPoolWith);
  return label === undefined ? {} : { poolPartnerLabel: label };
}

function EmptyState({
  loaded,
  onOpenAccounts,
}: {
  readonly loaded: boolean;
  readonly onOpenAccounts: () => void;
}): React.ReactElement {
  if (!loaded) {
    return (
      <div className="empty">
        <h2>Looking for signed-in subscriptions…</h2>
      </div>
    );
  }

  return (
    <div className="empty">
      <h2>No accounts connected yet</h2>
      <p>
        Connect a provider and its 5-hour, weekly and monthly usage will appear here. Signing in
        happens in the provider&apos;s own tool — this app never asks for your password and never
        uses API keys.
      </p>
      <button type="button" className="button button--primary button--large" onClick={onOpenAccounts}>
        <UserPlus size={15} aria-hidden="true" /> Connect an account
      </button>
    </div>
  );
}
