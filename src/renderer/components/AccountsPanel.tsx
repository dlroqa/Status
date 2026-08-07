/**
 * The accounts panel: connect providers, and manage what is tracked.
 *
 * Connecting deliberately hands off to the provider's own CLI rather than asking for
 * credentials here. Anthropic does not issue OAuth clients to third-party apps and its
 * terms forbid a third-party "sign in with Claude" flow, so the honest design is to let
 * the official tool do the authenticating and then read the session it wrote.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { FolderOpen, Loader2, RefreshCcw, Trash2, X } from 'lucide-react';
import { PROVIDER_LABELS, PROVIDERS, type Provider } from '@shared/account';
import type { AccountsView, InstallConsent, ManagedAccount, SignInProgress } from '@shared/ipc';
import type { MenuBarSetting } from '@shared/menubar';
import { ConnectRow } from './ConnectRow';
import { ProviderMark } from './ProviderMark';

interface AccountsPanelProps {
  readonly onClose: () => void;
  readonly configPath: string | undefined;
  readonly installId: string | undefined;
  readonly menuBar: MenuBarSetting | undefined;
}

type Notice = { readonly tone: 'ok' | 'error'; readonly text: string } | null;

export function AccountsPanel({
  onClose,
  configPath,
  installId,
  menuBar,
}: AccountsPanelProps): React.ReactElement {
  const [view, setView] = useState<AccountsView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [consents, setConsents] = useState<Record<string, InstallConsent | undefined>>({});
  const [progress, setProgress] = useState<Record<string, SignInProgress | undefined>>({});
  const [confirmingWipe, setConfirmingWipe] = useState(false);
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  const reload = useCallback(async () => {
    setView(await window.usageMonitor.getAccountsView());
  }, []);

  useEffect(() => {
    void reload();
    const stopAccounts = window.usageMonitor.onAccountsChanged(() => void reload());
    const stopProgress = window.usageMonitor.onSignInProgress((update) =>
      setProgress((current) => ({ ...current, [update.provider]: update })),
    );
    return () => {
      stopAccounts();
      stopProgress();
    };
  }, [reload]);

  // Escape closes, and focus starts inside the dialog so keyboard users are not stranded
  // behind it.
  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const run = useCallback(
    async (key: string, action: () => Promise<{ ok: boolean; reason?: string; detail?: string }>) => {
      setBusy(key);
      setNotice(null);
      try {
        const result = await action();
        setNotice(
          result.ok
            ? result.detail === undefined
              ? null
              : { tone: 'ok', text: result.detail }
            : { tone: 'error', text: result.reason ?? 'Something went wrong.' },
        );
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const signIn = (provider: Provider, installApproved: boolean): void => {
    setConsents((current) => ({ ...current, [provider]: undefined }));
    void run(`signin:${provider}`, async () => {
      const result = await window.usageMonitor.signIn(provider, installApproved);
      if (result.ok) return { ok: true, detail: result.detail };
      if ('consent' in result) {
        // Not an error: the client is missing and the user has not approved installing it.
        setConsents((current) => ({ ...current, [provider]: result.consent }));
        return { ok: true };
      }
      return { ok: false, reason: result.reason };
    });
  };

  const detect = (): void => {
    void run('detect', async () => {
      const result = await window.usageMonitor.detect();
      if (result.added.length > 0) {
        return { ok: true, detail: `Added ${result.added.map((a) => a.label).join(', ')}.` };
      }
      return { ok: false, reason: result.reason ?? 'Nothing new found.' };
    });
  };

  return (
    <div className="overlay" role="presentation" onMouseDown={onClose}>
      <div
        className="panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="panel__head">
          <h2 id={titleId}>Accounts</h2>
          <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label="Close accounts">
            <X size={15} aria-hidden="true" />
          </button>
        </header>

        {notice !== null && (
          <p className={`panel__notice panel__notice--${notice.tone}`} role="status">
            {notice.text}
          </p>
        )}

        <div className="panel__body">
          <section className="panel__section">
            <h3>Connect a provider</h3>
            <p className="panel__hint">
              Signing in happens in the provider&apos;s own tool. This app never asks for your
              password and never handles the login itself — it reads the session the CLI writes.
            </p>
            <ul className="rows">
              {PROVIDERS.map((provider) => (
                <ConnectRow
                  key={provider}
                  provider={provider}
                  status={view?.clis.find((cli) => cli.provider === provider)}
                  busy={busy === `signin:${provider}`}
                  folderBusy={busy === `folder:${provider}`}
                  consent={consents[provider]}
                  progress={progress[provider]}
                  onSignIn={() => signIn(provider, false)}
                  onApproveInstall={() => signIn(provider, true)}
                  onDismissConsent={() => setConsents((c) => ({ ...c, [provider]: undefined }))}
                  onCancel={() => void window.usageMonitor.cancelSignIn()}
                  onAddFolder={() =>
                    void run(`folder:${provider}`, () => window.usageMonitor.addFromFolder(provider))
                  }
                />
              ))}
            </ul>
            <button type="button" className="button" onClick={detect} disabled={busy === 'detect'}>
              {busy === 'detect' ? (
                <Loader2 size={13} className="spin" aria-hidden="true" />
              ) : (
                <RefreshCcw size={13} aria-hidden="true" />
              )}
              Detect accounts
            </button>
          </section>

          <section className="panel__section">
            <h3>Tracked accounts {view !== null && <span className="count">{view.accounts.length}</span>}</h3>
            {view !== null && view.accounts.length === 0 ? (
              <p className="panel__hint">
                Nothing tracked yet. Connect a provider above, then press Detect accounts.
              </p>
            ) : (
              <ul className="rows">
                {view?.accounts.map((account) => (
                  <ManagedRow
                    key={account.id}
                    account={account}
                    busy={busy?.endsWith(account.id) === true}
                    onRename={(label) => void run(`rename:${account.id}`, () => window.usageMonitor.rename(account.id, label))}
                    onCap={(cap) => void run(`cap:${account.id}`, () => window.usageMonitor.setMonthlyCap(account.id, cap))}
                    onRemove={() => void run(`remove:${account.id}`, () => window.usageMonitor.remove(account.id))}
                  />
                ))}
              </ul>
            )}
          </section>

          <section className="panel__section">
            <h3>Menu bar</h3>
            <p className="panel__hint">
              What the status item in the menu bar tracks.
            </p>
            <div className="menubar-choice">
              <label className="radio">
                <input
                  type="radio"
                  name="menubar-source"
                  checked={menuBar?.source !== 'chosen'}
                  onChange={() => void run('menubar', () => window.usageMonitor.setMenuBar({ source: 'closest' }))}
                />
                <span>
                  <strong>Closest to its limit</strong>
                  <em>Whichever account will run out first, across all windows.</em>
                </span>
              </label>
              <label className="radio">
                <input
                  type="radio"
                  name="menubar-source"
                  checked={menuBar?.source === 'chosen'}
                  disabled={view === null || view.accounts.length === 0}
                  onChange={() =>
                    void run('menubar', () =>
                      window.usageMonitor.setMenuBar({
                        source: 'chosen',
                        ...(view?.accounts[0] === undefined ? {} : { accountId: menuBar?.accountId ?? view.accounts[0].id }),
                      }),
                    )
                  }
                />
                <span>
                  <strong>A chosen account</strong>
                  <em>Always show one account&apos;s 5-hour usage.</em>
                </span>
              </label>

              {menuBar?.source === 'chosen' && view !== null && view.accounts.length > 0 && (
                <select
                  className="input"
                  aria-label="Account shown in the menu bar"
                  value={menuBar.accountId ?? view.accounts[0]?.id ?? ''}
                  onChange={(event) =>
                    void run('menubar', () =>
                      window.usageMonitor.setMenuBar({ source: 'chosen', accountId: event.target.value }),
                    )
                  }
                >
                  {view.accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.label}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </section>

          <section className="panel__section">
            <h3>Remove app data</h3>
            {confirmingWipe ? (
              <div className="danger">
                <p className="danger__text">
                  This deletes everything this app created: your account list, monthly caps and
                  this installation&apos;s id. Your Claude, ChatGPT and OpenCode sessions stay
                  signed in — this app did not create them. To sign out of those, run{' '}
                  <code>claude auth logout</code>, <code>codex logout</code> or{' '}
                  <code>opencode auth logout</code> yourself.
                </p>
                <div className="consent__actions">
                  <button
                    type="button"
                    className="button button--danger"
                    onClick={() =>
                      void run('wipe', async () => {
                        const report = await window.usageMonitor.removeAllData();
                        setConfirmingWipe(false);
                        return report.failed.length === 0
                          ? { ok: true, detail: `Removed ${report.removed.length} item(s). Provider sessions were left signed in.` }
                          : { ok: false, reason: `Could not remove: ${report.failed.map((f) => f.path).join(', ')}` };
                      })
                    }
                  >
                    <Trash2 size={13} aria-hidden="true" /> Remove everything
                  </button>
                  <button type="button" className="button button--quiet" onClick={() => setConfirmingWipe(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="button button--quiet" onClick={() => setConfirmingWipe(true)}>
                <Trash2 size={13} aria-hidden="true" /> Remove all app data…
              </button>
            )}
          </section>
        </div>

        <footer className="panel__foot">
          <span className="panel__path" title={`${configPath ?? ''}\ninstall id: ${installId ?? 'unknown'}`}>
            {installId === undefined ? (configPath ?? '') : `install ${installId.slice(0, 8)} · ${configPath ?? ''}`}
          </span>
          <button type="button" className="button button--quiet" onClick={() => void window.usageMonitor.revealConfig()}>
            <FolderOpen size={13} aria-hidden="true" /> Show config file
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Minor units (cents) are what the provider reports, so the input converts on both edges. */
function capToInput(minor: number | undefined): string {
  return minor === undefined ? '' : (minor / 100).toFixed(2);
}

function ManagedRow({
  account,
  busy,
  onRename,
  onCap,
  onRemove,
}: {
  readonly account: ManagedAccount;
  readonly busy: boolean;
  readonly onRename: (label: string) => void;
  readonly onCap: (capMinor: number | null) => void;
  readonly onRemove: () => void;
}): React.ReactElement {
  const [label, setLabel] = useState(account.label);
  const [cap, setCap] = useState(() => capToInput(account.monthlyCapMinor));
  const capId = useId();

  useEffect(() => setLabel(account.label), [account.label]);
  useEffect(() => setCap(capToInput(account.monthlyCapMinor)), [account.monthlyCapMinor]);

  const commitCap = (): void => {
    const trimmed = cap.trim();
    if (trimmed === '') {
      if (account.monthlyCapMinor !== undefined) onCap(null);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setCap(capToInput(account.monthlyCapMinor));
      return;
    }
    const minor = Math.round(parsed * 100);
    if (minor !== account.monthlyCapMinor) onCap(minor);
  };

  return (
    <li className="row">
      <ProviderMark provider={account.provider} />
      <div className="row__main">
        <input
          className="input input--label"
          value={label}
          aria-label={`Name for ${account.label}`}
          onChange={(event) => setLabel(event.target.value)}
          onBlur={() => label.trim() !== account.label && onRename(label)}
          onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
        />
        <div className="row__sub" title={account.configDir}>
          {PROVIDER_LABELS[account.provider]} · {account.configDir}
        </div>
      </div>
      <div className="row__actions">
        <label className="cap" htmlFor={capId}>
          <span className="cap__label">Monthly cap</span>
          <input
            id={capId}
            className="input input--cap mono"
            inputMode="decimal"
            placeholder="none"
            value={cap}
            onChange={(event) => setCap(event.target.value)}
            onBlur={commitCap}
            onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
          />
        </label>
        <button
          type="button"
          className="icon-button icon-button--danger"
          onClick={onRemove}
          disabled={busy}
          aria-label={`Stop tracking ${account.label}`}
          title="Stop tracking. The provider session is left signed in."
        >
          <Trash2 size={14} aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}
