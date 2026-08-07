/**
 * Electron main process: owns configuration, credentials, network and the poll loop.
 *
 * The renderer is treated as untrusted. It runs sandboxed with context isolation, cannot
 * reach Node or the filesystem, is forbidden from navigating anywhere, and is served under
 * a content security policy that blocks every remote origin. All network access happens
 * here, so a subscription token never enters a web context.
 */

import { join } from 'node:path';
import { BrowserWindow, app, dialog, ipcMain, nativeTheme, session, shell } from 'electron';
import { DEFAULT_POLL_SECONDS } from '@shared/config';
import type { Provider } from '@shared/account';
import { IPC, type AccountsView, type AppInfo, type UsageSnapshot } from '@shared/ipc';
import { AccountManager } from './accounts';
import { Collector, mergeDiscovered } from './collector';
import { ConfigStore } from './config';
import { discoverAccounts } from './discovery';
import { createLogger } from './logger';
import { isFailedPass, nextDelayMs } from './poller';
import { createAdapters } from './providers';
import { messageOf } from './scope';

const logger = createLogger('main');
const adapters = createAdapters();

let configStore: ConfigStore;
let collector: Collector;
let accountManager: AccountManager;
let mainWindow: BrowserWindow | null = null;

let latestSnapshot: UsageSnapshot = {
  accounts: [],
  fetchedAt: new Date(0).toISOString(),
  refreshing: true,
};
let consecutiveFailures = 0;
let pollTimer: NodeJS.Timeout | undefined;
let inFlight: AbortController | undefined;

/**
 * The window's native background must match the theme the stylesheet will actually paint.
 * The renderer follows the OS via prefers-color-scheme, so a hardcoded dark background
 * would show a dark frame for a beat and then repaint light on a light desktop.
 */
const WINDOW_BACKGROUND = { dark: '#0f172a', light: '#f6f7f9' } as const;

function backgroundForTheme(): string {
  return nativeTheme.shouldUseDarkColors ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light;
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1_040,
    height: 720,
    minWidth: 720,
    minHeight: 420,
    show: false,
    backgroundColor: backgroundForTheme(),
    title: 'AI Usage Monitor',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  // Avoid a white flash before the dark UI paints.
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // The app has no business opening windows or navigating; external links go to the browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devServerUrl !== undefined && !app.isPackaged) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Keep the frame in step if the desktop switches theme while the app is open.
  const syncBackground = (): void => mainWindow?.setBackgroundColor(backgroundForTheme());
  nativeTheme.on('updated', syncBackground);
  mainWindow.on('closed', () => nativeTheme.off('updated', syncBackground));
}

/**
 * A strict CSP as a response header.
 *
 * Fonts and styles are bundled into the app, so no remote origin needs to be reachable.
 * `connect-src 'none'` means that even if renderer code tried to call an API directly, it
 * could not — network access is structurally confined to the main process.
 */
function applyContentSecurityPolicy(): void {
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    // Vite injects styles as inline <style> tags in development and for bundled CSS.
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data:",
    "connect-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [policy] },
    });
  });
}

function publish(snapshot: UsageSnapshot): void {
  latestSnapshot = snapshot;
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.snapshot, snapshot);
  }
}

async function runCollection(): Promise<UsageSnapshot> {
  inFlight?.abort();
  const controller = new AbortController();
  inFlight = controller;

  publish({ ...latestSnapshot, refreshing: true });

  try {
    const snapshot = await collector.collect({ signal: controller.signal });
    consecutiveFailures = isFailedPass(snapshot) ? consecutiveFailures + 1 : 0;
    publish(snapshot);
    return snapshot;
  } catch (error) {
    // collect() handles expected failures internally, so reaching here means a defect.
    logger.error('collection failed:', error);
    consecutiveFailures += 1;
    const snapshot: UsageSnapshot = {
      ...latestSnapshot,
      refreshing: false,
      configError: `collection failed: ${messageOf(error)}`,
    };
    publish(snapshot);
    return snapshot;
  } finally {
    if (inFlight === controller) inFlight = undefined;
  }
}

async function scheduleNextPoll(): Promise<void> {
  if (pollTimer !== undefined) clearTimeout(pollTimer);
  const { config } = await configStore.load();
  const delay = nextDelayMs(config.pollSeconds, consecutiveFailures);
  pollTimer = setTimeout(() => {
    void runCollection().finally(() => {
      void scheduleNextPoll();
    });
  }, delay);
}

/** Adds any provider whose default directory holds a signed-in subscription. */
async function seedAccountsOnFirstRun(): Promise<void> {
  const { config, error } = await configStore.load();
  if (error !== undefined) {
    logger.warn('not seeding accounts because the config could not be read:', error);
    return;
  }
  if (config.accounts.length > 0) return;

  const discovered = await discoverAccounts(adapters, logger);
  if (discovered.length === 0) {
    logger.info('no signed-in subscriptions found in the default locations');
    return;
  }

  await configStore.save(mergeDiscovered(config, discovered));
  logger.info(`registered ${discovered.length} account(s) on first run`);
}

function notifyAccountsChanged(): void {
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.accountsChanged);
  }
}

/**
 * Delay before a config change triggers a fresh poll.
 *
 * Editing accounts must not turn into a burst of requests: a monthly cap is committed on
 * every blur, and polling the provider on each keystroke-and-tab earned a 429 in testing.
 * Coalescing the edits into one refresh keeps the app well-behaved without making the UI
 * feel stale.
 */
const ACCOUNT_REFRESH_DEBOUNCE_MS = 1_200;
let accountRefreshTimer: NodeJS.Timeout | undefined;

/**
 * Reflects an account change in the UI, refreshing data only when the change can alter it.
 *
 * `dataAffected` is false for a rename, which changes nothing the provider reports.
 */
function afterAccountChange(dataAffected = true): void {
  notifyAccountsChanged();
  if (!dataAffected) return;

  if (accountRefreshTimer !== undefined) clearTimeout(accountRefreshTimer);
  accountRefreshTimer = setTimeout(() => {
    accountRefreshTimer = undefined;
    void runCollection().finally(() => {
      void scheduleNextPoll();
    });
  }, ACCOUNT_REFRESH_DEBOUNCE_MS);
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC.getSnapshot, () => latestSnapshot);
  ipcMain.handle(IPC.refresh, async () => {
    const snapshot = await runCollection();
    void scheduleNextPoll();
    return snapshot;
  });
  ipcMain.handle(IPC.getAppInfo, async (): Promise<AppInfo> => {
    const { config } = await configStore.load();
    return {
      version: app.getVersion(),
      configPath: configStore.filePath,
      pollSeconds: config.pollSeconds ?? DEFAULT_POLL_SECONDS,
    };
  });

  // Reveals the file in Finder/Explorer rather than opening it. Opening a .json hands it to
  // whichever editor claims that extension, which is not something the user asked for.
  ipcMain.handle(IPC.revealConfig, async () => {
    const { config, error } = await configStore.load();
    if (error === undefined) await configStore.save(config);
    shell.showItemInFolder(configStore.filePath);
  });

  ipcMain.handle(IPC.getAccountsView, async (): Promise<AccountsView> => {
    const [accounts, clis] = await Promise.all([
      accountManager.listAccounts(),
      accountManager.cliStatuses(),
    ]);
    return {
      accounts,
      clis: clis.map(({ provider, command, installed, installUrl }) => ({
        provider,
        command,
        installed,
        installUrl,
      })),
    };
  });

  ipcMain.handle(IPC.connect, (_event, provider: Provider) => accountManager.connect(provider));

  ipcMain.handle(IPC.detect, async () => {
    const result = await accountManager.detect();
    if (result.added.length > 0) afterAccountChange();
    return result;
  });

  ipcMain.handle(IPC.rename, async (_event, id: string, label: string) => {
    const result = await accountManager.rename(id, label);
    // A name is display-only, so there is nothing to re-fetch.
    if (result.ok) afterAccountChange(false);
    return result;
  });

  ipcMain.handle(IPC.setMonthlyCap, async (_event, id: string, capMinor: number | null) => {
    const result = await accountManager.setMonthlyCap(id, capMinor);
    if (result.ok) afterAccountChange();
    return result;
  });

  ipcMain.handle(IPC.remove, async (_event, id: string) => {
    const result = await accountManager.remove(id);
    if (result.ok) afterAccountChange();
    return result;
  });

  ipcMain.handle(IPC.addFromFolder, async (_event, provider: Provider) => {
    const window = mainWindow;
    const options = {
      title: 'Choose the config folder that account is signed in to',
      properties: ['openDirectory' as const, 'createDirectory' as const],
    };
    const picked = window === null
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(window, options);

    const directory = picked.filePaths[0];
    if (picked.canceled || directory === undefined) {
      return { ok: false as const, reason: 'No folder chosen.' };
    }

    const result = await accountManager.addFromFolder(provider, directory);
    if (result.ok) afterAccountChange();
    return result;
  });
}

app.whenReady().then(async () => {
  configStore = new ConfigStore(join(app.getPath('userData'), 'config.json'));
  collector = new Collector(adapters, configStore, logger);
  accountManager = new AccountManager(adapters, configStore, logger);

  applyContentSecurityPolicy();
  registerIpcHandlers();
  createWindow();

  await seedAccountsOnFirstRun();
  await runCollection();
  await scheduleNextPoll();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}, (error: unknown) => {
  logger.error('failed to start:', error);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (pollTimer !== undefined) clearTimeout(pollTimer);
  if (accountRefreshTimer !== undefined) clearTimeout(accountRefreshTimer);
  inFlight?.abort();
});
