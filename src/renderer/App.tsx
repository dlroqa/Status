import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Settings2 } from 'lucide-react';
import type { AccountUsage } from '@shared/account';
import { formatAgo } from '@shared/format';
import type { AppInfo, UsageSnapshot } from '@shared/ipc';
import { AccountRow } from './components/AccountRow';

const EMPTY_SNAPSHOT: UsageSnapshot = {
  accounts: [],
  fetchedAt: new Date(0).toISOString(),
  refreshing: true,
};

export function App(): React.ReactElement {
  const [snapshot, setSnapshot] = useState<UsageSnapshot>(EMPTY_SNAPSHOT);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
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
          <EmptyState loaded={hasLoaded} configPath={appInfo?.configPath} />
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
        <button type="button" onClick={() => void window.usageMonitor.openConfig()}>
          <Settings2 size={12} aria-hidden="true" /> Edit accounts
        </button>
      </footer>
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
  configPath,
}: {
  readonly loaded: boolean;
  readonly configPath: string | undefined;
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
      <h2>No subscription accounts found</h2>
      <p>
        This monitor reads the subscription sessions your CLIs already hold. Sign in to one and it will
        appear here — no API keys are used or accepted.
      </p>
      <p>
        Claude: run <code>claude</code> · ChatGPT: run <code>codex login</code> · OpenCode: run{' '}
        <code>opencode auth login</code>
      </p>
      {configPath !== undefined && (
        <p>
          To watch a second account of the same provider, add it to <code>{configPath}</code> with its own
          config directory.
        </p>
      )}
    </div>
  );
}
