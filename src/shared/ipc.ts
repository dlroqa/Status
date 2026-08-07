/**
 * The contract between main and renderer.
 *
 * Only these shapes cross the bridge. Access tokens and raw credential contents are not
 * part of any payload here, by design — they never leave the main process.
 */

import type { AccountUsage } from './account';

export const IPC = {
  /** Renderer -> main: return the latest snapshot immediately, without forcing a poll. */
  getSnapshot: 'usage:get-snapshot',
  /** Renderer -> main: poll every account now. */
  refresh: 'usage:refresh',
  /** Main -> renderer: a new snapshot is available. */
  snapshot: 'usage:snapshot',
  /** Renderer -> main: open the config file in the OS editor. */
  openConfig: 'app:open-config',
  /** Renderer -> main: static app info for the footer. */
  getAppInfo: 'app:get-info',
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
}

/** The surface exposed on `window.usageMonitor` by the preload script. */
export interface UsageMonitorBridge {
  getSnapshot(): Promise<UsageSnapshot>;
  refresh(): Promise<UsageSnapshot>;
  getAppInfo(): Promise<AppInfo>;
  openConfig(): Promise<void>;
  /** Subscribes to pushed snapshots; returns an unsubscribe function. */
  onSnapshot(listener: (snapshot: UsageSnapshot) => void): () => void;
}
