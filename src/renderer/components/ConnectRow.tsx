/**
 * One provider in the accounts panel: sign in, or add a second account by folder.
 *
 * Signing in hands off to the provider's own client. When that client is missing, the exact
 * vendor command is shown and approved before anything runs — an app that silently pipes a
 * remote script into a shell is not something to do quietly.
 */

import { FolderOpen, Loader2, LogIn } from 'lucide-react';
import { PROVIDER_LABELS, type Provider } from '@shared/account';
import type { InstallConsent, ProviderCliStatus, SignInProgress } from '@shared/ipc';
import { ProviderMark } from './ProviderMark';

interface ConnectRowProps {
  readonly provider: Provider;
  readonly status: ProviderCliStatus | undefined;
  readonly busy: boolean;
  readonly folderBusy: boolean;
  /** Set while this provider is waiting for the user to approve installing its client. */
  readonly consent: InstallConsent | undefined;
  readonly progress: SignInProgress | undefined;
  readonly onSignIn: () => void;
  readonly onApproveInstall: () => void;
  readonly onDismissConsent: () => void;
  readonly onCancel: () => void;
  readonly onAddFolder: () => void;
}

export function ConnectRow({
  provider,
  status,
  busy,
  folderBusy,
  consent,
  progress,
  onSignIn,
  onApproveInstall,
  onDismissConsent,
  onCancel,
  onAddFolder,
}: ConnectRowProps): React.ReactElement {
  const installed = status?.installed === true;

  return (
    <li className="row row--stack">
      <div className="row__lead">
        <ProviderMark provider={provider} />
        <div className="row__main">
          <div className="row__title">{PROVIDER_LABELS[provider]}</div>
          <div className="row__sub">
            {progress !== undefined && busy
              ? progress.message
              : status === undefined
                ? 'checking…'
                : installed
                  ? 'ready to sign in'
                  : `${status.command} will be installed when you sign in`}
          </div>
        </div>
        <div className="row__actions">
          {busy ? (
            <button type="button" className="button" onClick={onCancel}>
              <Loader2 size={13} className="spin" aria-hidden="true" /> Cancel
            </button>
          ) : (
            <>
              <button type="button" className="button button--primary" onClick={onSignIn}>
                <LogIn size={13} aria-hidden="true" /> Sign in
              </button>
              {installed && (
                <button
                  type="button"
                  className="button button--quiet"
                  onClick={onAddFolder}
                  disabled={folderBusy}
                  title="Add a second account of this provider by pointing at the config folder it is signed in to"
                >
                  <FolderOpen size={13} aria-hidden="true" /> Add folder…
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {consent !== undefined && (
        <div className="consent" role="group" aria-label={`Install ${PROVIDER_LABELS[provider]}`}>
          <p className="consent__text">
            {PROVIDER_LABELS[provider]}&apos;s official client is not installed. Signing in will run
            this command, published by the provider:
          </p>
          <code className="consent__command mono">{consent.command}</code>
          <div className="consent__actions">
            <button type="button" className="button button--primary" onClick={onApproveInstall}>
              Install and sign in
            </button>
            <button type="button" className="button button--quiet" onClick={onDismissConsent}>
              Not now
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
