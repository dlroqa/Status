/**
 * The accounts panel: connect providers, and manage what is tracked.
 *
 * Connecting deliberately hands off to the provider's own CLI rather than asking for
 * credentials here. Anthropic does not issue OAuth clients to third-party apps and its
 * terms forbid a third-party "sign in with Claude" flow, so the honest design is to let
 * the official tool do the authenticating and then read the session it wrote.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ExternalLink, FolderOpen, Loader2, LogIn, RefreshCcw, Trash2, X } from 'lucide-react';
import { PROVIDER_LABELS, PROVIDERS, type Provider } from '@shared/account';
import type { AccountsView, ManagedAccount, ProviderCliStatus } from '@shared/ipc';
import { ProviderMark } from './ProviderMark';

interface AccountsPanelProps {
  readonly onClose: () => void;
  readonly configPath: string | undefined;
}

type Notice = { readonly tone: 'ok' | 'error'; readonly text: string } | null;

export function AccountsPanel({ onClose, configPath }: AccountsPanelProps): React.ReactElement {
  const [view, setView] = useState<AccountsView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  const reload = useCallback(async () => {
    setView(await window.usageMonitor.getAccountsView());
  }, []);

  useEffect(() => {
    void reload();
    return window.usageMonitor.onAccountsChanged(() => void reload());
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

  const connect = (provider: Provider): void => {
    void run(`connect:${provider}`, async () => {
      const result = await window.usageMonitor.connect(provider);
      if (result.ok) {
        return {
          ok: true,
          detail: `Sign in to ${PROVIDER_LABELS[provider]} in the terminal that just opened, then press "Detect accounts".`,
        };
      }
      return result;
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
                  busy={busy === `connect:${provider}`}
                  onConnect={() => connect(provider)}
                  onAddFolder={() =>
                    void run(`folder:${provider}`, () => window.usageMonitor.addFromFolder(provider))
                  }
                  folderBusy={busy === `folder:${provider}`}
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
        </div>

        <footer className="panel__foot">
          <span className="panel__path" title={configPath}>
            {configPath ?? ''}
          </span>
          <button type="button" className="button button--quiet" onClick={() => void window.usageMonitor.revealConfig()}>
            <FolderOpen size={13} aria-hidden="true" /> Show config file
          </button>
        </footer>
      </div>
    </div>
  );
}

function ConnectRow({
  provider,
  status,
  busy,
  folderBusy,
  onConnect,
  onAddFolder,
}: {
  readonly provider: Provider;
  readonly status: ProviderCliStatus | undefined;
  readonly busy: boolean;
  readonly folderBusy: boolean;
  readonly onConnect: () => void;
  readonly onAddFolder: () => void;
}): React.ReactElement {
  const installed = status?.installed === true;

  return (
    <li className="row">
      <ProviderMark provider={provider} />
      <div className="row__main">
        <div className="row__title">{PROVIDER_LABELS[provider]}</div>
        <div className="row__sub">
          {status === undefined
            ? 'checking…'
            : installed
              ? `${status.command} is installed`
              : `${status.command} is not installed`}
        </div>
      </div>
      <div className="row__actions">
        {installed ? (
          <>
            <button type="button" className="button button--primary" onClick={onConnect} disabled={busy}>
              {busy ? <Loader2 size={13} className="spin" aria-hidden="true" /> : <LogIn size={13} aria-hidden="true" />}
              Connect
            </button>
            <button
              type="button"
              className="button button--quiet"
              onClick={onAddFolder}
              disabled={folderBusy}
              title="Add a second account of this provider by pointing at the config folder it is signed in to"
            >
              <FolderOpen size={13} aria-hidden="true" /> Add folder…
            </button>
          </>
        ) : (
          <a className="button button--quiet" href={status?.installUrl ?? '#'} target="_blank" rel="noreferrer noopener">
            <ExternalLink size={13} aria-hidden="true" /> Install
          </a>
        )}
      </div>
    </li>
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
