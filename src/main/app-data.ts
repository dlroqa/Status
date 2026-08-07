/**
 * Removing everything this app created.
 *
 * macOS has no uninstall hook — dragging an .app to the Trash runs nothing — so an in-app
 * action is the only way to clean up there. Windows gets the same result from the NSIS
 * uninstaller, and the .deb removes installed files, but per-user data always needs this.
 *
 * It removes only what this app wrote. Provider sessions are left signed in on purpose:
 * Claude Code, Codex and OpenCode are separate tools the user runs independently, and
 * silently logging them out of those because they removed a usage monitor would be
 * destructive and surprising.
 */

import { rm } from 'node:fs/promises';
import type { Logger } from './logger';
import { messageOf } from './scope';

/** Named so the UI can tell the user exactly what went, rather than "done". */
export interface RemovalReport {
  readonly removed: readonly string[];
  readonly failed: readonly { readonly path: string; readonly reason: string }[];
}

export interface RemovalTargets {
  /** Absolute paths this app owns. Each may or may not exist. */
  readonly files: readonly string[];
  /** Clears Electron's own storage (cache, cookies, local storage) for the app's session. */
  readonly clearBrowserStorage: () => Promise<void>;
  readonly logger: Logger;
}

export async function removeAllAppData(targets: RemovalTargets): Promise<RemovalReport> {
  const removed: string[] = [];
  const failed: { path: string; reason: string }[] = [];

  for (const path of targets.files) {
    try {
      // `force` makes a missing file a success: the goal is absence, not deletion.
      await rm(path, { force: true, recursive: true });
      removed.push(path);
    } catch (error) {
      targets.logger.error(`could not remove ${path}:`, error);
      failed.push({ path, reason: messageOf(error) });
    }
  }

  try {
    await targets.clearBrowserStorage();
    removed.push('browser storage');
  } catch (error) {
    targets.logger.error('could not clear browser storage:', error);
    failed.push({ path: 'browser storage', reason: messageOf(error) });
  }

  return { removed, failed };
}

/**
 * The commands that sign out of each provider.
 *
 * Shown to the user rather than run: this app did not create those sessions and does not
 * remove them. Signing out stays a deliberate act.
 */
export const PROVIDER_SIGN_OUT_COMMANDS: readonly string[] = [
  'claude auth logout',
  'codex logout',
  'opencode auth logout',
];
