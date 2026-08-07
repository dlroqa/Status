/**
 * Electron main process: owns configuration, credentials, network and the poll loop.
 *
 * The renderer is treated as untrusted. It runs sandboxed with context isolation, cannot
 * reach Node or the filesystem, is forbidden from navigating anywhere, and is served under
 * a content security policy that blocks every remote origin. All network access happens
 * here, so a subscription token never enters a web context.
 */

import { join } from 'node:path';
import { BrowserWindow, app, ipcMain, nativeTheme, session, shell } from 'electron';
import { DEFAULT_POLL_SECONDS } from '@shared/config';
import { IPC, type AppInfo, type UsageSnapshot } from '@shared/ipc';
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
  ipcMain.handle(IPC.openConfig, async () => {
    // Ensure the file exists before asking the OS to open it.
    const { config, error } = await configStore.load();
    if (error === undefined) await configStore.save(config);
    await shell.openPath(configStore.filePath);
  });
}

app.whenReady().then(async () => {
  configStore = new ConfigStore(join(app.getPath('userData'), 'config.json'));
  collector = new Collector(adapters, configStore, logger);

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
  inFlight?.abort();
});
