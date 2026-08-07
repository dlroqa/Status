/**
 * The entire renderer-facing surface.
 *
 * This runs sandboxed with context isolation on, so the renderer gets these functions and
 * nothing else — no Node, no filesystem, no direct IPC. Access tokens never appear in any
 * payload that crosses this boundary.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { Provider } from '../shared/account';
import type { MenuBarSetting } from '../shared/menubar';
import {
  IPC,
  type AccountsView,
  type ActionResult,
  type AppInfo,
  type DetectResult,
  type RemovalOutcome,
  type SignInOutcome,
  type UsageMonitorBridge,
  type UsageSnapshot,
} from '../shared/ipc';

function subscribe(channel: string, listener: (...args: never[]) => void): () => void {
  const handler = (_event: unknown, ...args: unknown[]): void => {
    (listener as (...a: unknown[]) => void)(...args);
  };
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const bridge: UsageMonitorBridge = {
  getSnapshot: () => ipcRenderer.invoke(IPC.getSnapshot) as Promise<UsageSnapshot>,
  refresh: () => ipcRenderer.invoke(IPC.refresh) as Promise<UsageSnapshot>,
  getAppInfo: () => ipcRenderer.invoke(IPC.getAppInfo) as Promise<AppInfo>,
  revealConfig: () => ipcRenderer.invoke(IPC.revealConfig) as Promise<void>,

  getAccountsView: () => ipcRenderer.invoke(IPC.getAccountsView) as Promise<AccountsView>,
  connect: (provider: Provider) => ipcRenderer.invoke(IPC.connect, provider) as Promise<ActionResult>,
  detect: () => ipcRenderer.invoke(IPC.detect) as Promise<DetectResult>,
  rename: (id: string, label: string) => ipcRenderer.invoke(IPC.rename, id, label) as Promise<ActionResult>,
  setMonthlyCap: (id: string, capMinor: number | null) =>
    ipcRenderer.invoke(IPC.setMonthlyCap, id, capMinor) as Promise<ActionResult>,
  remove: (id: string) => ipcRenderer.invoke(IPC.remove, id) as Promise<ActionResult>,
  addFromFolder: (provider: Provider) =>
    ipcRenderer.invoke(IPC.addFromFolder, provider) as Promise<ActionResult>,
  signIn: (provider: Provider, installApproved: boolean) =>
    ipcRenderer.invoke(IPC.signIn, provider, installApproved) as Promise<SignInOutcome>,
  cancelSignIn: () => ipcRenderer.invoke(IPC.cancelSignIn) as Promise<void>,
  setMenuBar: (setting: MenuBarSetting) =>
    ipcRenderer.invoke(IPC.setMenuBar, setting) as Promise<ActionResult>,
  showMainWindow: () => ipcRenderer.invoke(IPC.showMainWindow) as Promise<void>,
  removeAllData: () => ipcRenderer.invoke(IPC.removeAllData) as Promise<RemovalOutcome>,

  onSnapshot: (listener) => subscribe(IPC.snapshot, listener as never),
  onAccountsChanged: (listener) => subscribe(IPC.accountsChanged, listener as never),
  onSignInProgress: (listener) => subscribe(IPC.signInProgress, listener as never),
};

contextBridge.exposeInMainWorld('usageMonitor', bridge);
