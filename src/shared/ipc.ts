/**
 * The contract between main and renderer.
 *
 * Only these shapes cross the bridge. Access tokens and raw credential contents are not
 * part of any payload here, by design — they never leave the main process.
 */

import type { AccountUsage, Provider } from './account';
import type { MenuBarSetting } from './menubar';

export const IPC = {
  /** Renderer -> main: return the latest snapshot immediately, without forcing a poll. */
  getSnapshot: 'usage:get-snapshot',
  /** Renderer -> main: poll every account now. */
  refresh: 'usage:refresh',
  /** Main -> renderer: a new snapshot is available. */
  snapshot: 'usage:snapshot',
  /** Renderer -> main: static app info for the footer. */
  getAppInfo: 'app:get-info',
  /** Renderer -> main: show the config file in the OS file manager. */
  revealConfig: 'app:reveal-config',

  /** Renderer -> main: which provider CLIs are installed, and which accounts are configured. */
  getAccountsView: 'accounts:get',
  /** Renderer -> main: open the provider's own CLI sign-in in a terminal. */
  connect: 'accounts:connect',
  /** Renderer -> main: look for newly signed-in accounts and register them. */
  detect: 'accounts:detect',
  /** Renderer -> main: rename an account. */
  rename: 'accounts:rename',
  /** Renderer -> main: set or clear an account's monthly spend cap. */
  setMonthlyCap: 'accounts:set-monthly-cap',
  /** Renderer -> main: stop tracking an account. */
  remove: 'accounts:remove',
  /** Renderer -> main: register an account from a config directory chosen in a dialog. */
  addFromFolder: 'accounts:add-from-folder',
  /** Main -> renderer: the account list or CLI availability changed. */
  accountsChanged: 'accounts:changed',

  /** Renderer -> main: install if needed, hand off to the browser, then detect the session. */
  signIn: 'accounts:sign-in',
  /** Renderer -> main: abort an in-flight sign-in. */
  cancelSignIn: 'accounts:cancel-sign-in',
  /** Main -> renderer: sign-in progress. */
  signInProgress: 'accounts:sign-in-progress',

  /** Renderer -> main: change what the menu-bar item tracks. */
  setMenuBar: 'menubar:set',
  /** Renderer -> main (popover): bring up the full window. */
  showMainWindow: 'window:show-main',

  /** Renderer -> main: delete everything this app created. */
  removeAllData: 'app:remove-all-data',
} as const;

export interface UsageSnapshot {
  readonly accounts: readonly AccountUsage[];
  /** ISO-8601 instant this collection pass completed. */
  readonly fetchedAt: string;
  /** True while a poll is in flight, so the UI can show activity without flicker. */
  readonly refreshing: boolean;
  /** Set when configuration itself could not be loaded — a whole-app problem, not a per-account one. */
  readonly configError?: string;
}

export interface AppInfo {
  readonly version: string;
  readonly configPath: string;
  readonly pollSeconds: number;
  /** Random, per-installation, never transmitted. Shown so it is inspectable. */
  readonly installId: string;
  /** Lets the UI adapt to the platform without sniffing the user agent. */
  readonly platform: NodeJS.Platform;
  readonly menuBar: MenuBarSetting;
}

/** Whether a provider's CLI is available, and how to get it if not. */
export interface ProviderCliStatus {
  readonly provider: Provider;
  readonly command: string;
  readonly installed: boolean;
  readonly installUrl: string;
}

/** One configured account, as shown in the accounts panel. */
export interface ManagedAccount {
  readonly id: string;
  readonly provider: Provider;
  readonly label: string;
  readonly configDir: string;
  readonly monthlyCapMinor?: number;
}

export interface AccountsView {
  readonly accounts: readonly ManagedAccount[];
  readonly clis: readonly ProviderCliStatus[];
}

/** Stages a sign-in moves through, so the panel can show what is happening. */
export const SIGN_IN_PHASES = ['checking', 'installing', 'awaiting-approval', 'detecting', 'done', 'error'] as const;
export type SignInPhase = (typeof SIGN_IN_PHASES)[number];

export interface SignInProgress {
  readonly provider: Provider;
  readonly phase: SignInPhase;
  /** Already redacted. Never contains a token or an authorization URL. */
  readonly message: string;
}

/**
 * Returned when the provider's client is missing and the user has not yet approved
 * installing it. `command` is the exact vendor command that would run.
 */
export interface InstallConsent {
  readonly provider: Provider;
  readonly command: string;
}

/** What a sign-in attempt returned. */
export type SignInOutcome =
  | { readonly ok: true; readonly detail: string }
  /** The provider's client is missing; show `consent.command` and ask before installing. */
  | { readonly ok: false; readonly consent: InstallConsent }
  | { readonly ok: false; readonly reason: string };

export interface RemovalOutcome {
  readonly removed: readonly string[];
  readonly failed: readonly { readonly path: string; readonly reason: string }[];
  /** Commands the user can run themselves to sign out; this app does not run them. */
  readonly signOutCommands: readonly string[];
}

/** Result of an action that can fail for reasons the user needs to read. */
export type ActionResult = { readonly ok: true; readonly detail?: string } | { readonly ok: false; readonly reason: string };

export interface DetectResult {
  readonly added: readonly ManagedAccount[];
  /** Set when nothing new was found, explaining what was looked for. */
  readonly reason?: string;
}

/** The surface exposed on `window.usageMonitor` by the preload script. */
export interface UsageMonitorBridge {
  getSnapshot(): Promise<UsageSnapshot>;
  refresh(): Promise<UsageSnapshot>;
  getAppInfo(): Promise<AppInfo>;
  revealConfig(): Promise<void>;

  getAccountsView(): Promise<AccountsView>;
  connect(provider: Provider): Promise<ActionResult>;
  detect(): Promise<DetectResult>;
  rename(id: string, label: string): Promise<ActionResult>;
  setMonthlyCap(id: string, capMinor: number | null): Promise<ActionResult>;
  remove(id: string): Promise<ActionResult>;
  addFromFolder(provider: Provider): Promise<ActionResult>;
  signIn(provider: Provider, installApproved: boolean): Promise<SignInOutcome>;
  cancelSignIn(): Promise<void>;
  setMenuBar(setting: MenuBarSetting): Promise<ActionResult>;
  showMainWindow(): Promise<void>;
  removeAllData(): Promise<RemovalOutcome>;

  /** Subscribes to pushed snapshots; returns an unsubscribe function. */
  onSnapshot(listener: (snapshot: UsageSnapshot) => void): () => void;
  /** Subscribes to account-list changes; returns an unsubscribe function. */
  onAccountsChanged(listener: () => void): () => void;
  /** Subscribes to sign-in progress; returns an unsubscribe function. */
  onSignInProgress(listener: (progress: SignInProgress) => void): () => void;
}
