/**
 * The entire renderer-facing surface.
 *
 * This runs sandboxed with context isolation on, so the renderer gets these functions and
 * nothing else — no Node, no filesystem, no direct IPC. Access tokens never appear in any
 * payload that crosses this boundary.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type AppInfo, type UsageMonitorBridge, type UsageSnapshot } from '../shared/ipc';

const bridge: UsageMonitorBridge = {
  getSnapshot: () => ipcRenderer.invoke(IPC.getSnapshot) as Promise<UsageSnapshot>,
  refresh: () => ipcRenderer.invoke(IPC.refresh) as Promise<UsageSnapshot>,
  getAppInfo: () => ipcRenderer.invoke(IPC.getAppInfo) as Promise<AppInfo>,
  openConfig: () => ipcRenderer.invoke(IPC.openConfig) as Promise<void>,
  onSnapshot: (listener) => {
    const handler = (_event: unknown, snapshot: UsageSnapshot): void => listener(snapshot);
    ipcRenderer.on(IPC.snapshot, handler);
    return () => {
      ipcRenderer.removeListener(IPC.snapshot, handler);
    };
  },
};

contextBridge.exposeInMainWorld('usageMonitor', bridge);
