import type { UsageMonitorBridge } from '@shared/ipc';

declare global {
  interface Window {
    /** Exposed by the preload script; the renderer's only channel to the main process. */
    readonly usageMonitor: UsageMonitorBridge;
  }
}

export {};
