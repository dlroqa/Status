/**
 * The macOS menu-bar item, and its popover.
 *
 * `Tray.setTitle` is macOS-only and draws text beside the icon, which is what puts the
 * figure in the upper right. Menu-bar *text* cannot be coloured, so severity is carried by
 * the icon: a dot drawn at runtime in the same green/amber/red the bars use, from the one
 * threshold definition in `@shared/severity`.
 *
 * The dot is deliberately **not** a template image. macOS tints template images to match the
 * menu bar, which would erase exactly the signal it exists to convey.
 */

import { BrowserWindow, Tray, app, nativeImage, screen } from 'electron';
import { join } from 'node:path';
import type { MenuBarDisplay } from '@shared/menubar';
import type { Severity } from '@shared/severity';

const DOT_SIZE = 16;
const POPOVER_WIDTH = 400;
const POPOVER_HEIGHT = 460;

/** Same values as the CSS tokens; kept here because a native image cannot read CSS. */
const SEVERITY_COLOURS: Record<Severity, string> = {
  normal: '#22c55e',
  elevated: '#f59e0b',
  critical: '#ef4444',
};
const UNKNOWN_COLOUR = '#8695ab';

/**
 * Draws the status dot as an SVG data URL.
 *
 * Rendering it here rather than shipping three PNGs means the colours cannot drift away from
 * the severity thresholds, and a "no reading" state gets a visibly hollow dot rather than a
 * confident colour.
 */
function dotImage(severity: Severity | undefined): Electron.NativeImage {
  const colour = severity === undefined ? UNKNOWN_COLOUR : SEVERITY_COLOURS[severity];
  const centre = DOT_SIZE / 2;
  const shape =
    severity === undefined
      ? `<circle cx="${centre}" cy="${centre}" r="4.5" fill="none" stroke="${colour}" stroke-width="1.6"/>`
      : `<circle cx="${centre}" cy="${centre}" r="5" fill="${colour}"/>`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${DOT_SIZE}" height="${DOT_SIZE}" viewBox="0 0 ${DOT_SIZE} ${DOT_SIZE}">${shape}</svg>`;
  const image = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
  // Not a template image, so the colour survives.
  image.setTemplateImage(false);
  return image;
}

export interface MenuBarDeps {
  readonly preloadPath: string;
  readonly rendererUrl: string | undefined;
  readonly rendererFile: string;
  readonly onShowMainWindow: () => void;
  /** Called when this desktop has no system tray, so the caller can note it once. */
  readonly onTrayUnavailable: (error: unknown) => void;
}

export class MenuBar {
  private tray: Tray | undefined;
  private popover: BrowserWindow | undefined;

  constructor(private readonly deps: MenuBarDeps) {}

  /**
   * Creates the status item.
   *
   * Not every desktop has a system tray — several Linux sessions ship without one, and
   * constructing a Tray there throws. The app is fully usable through its window, so a
   * missing tray is logged and the rest carries on rather than taking the app down.
   */
  start(): boolean {
    if (this.tray !== undefined) return true;

    try {
      this.tray = new Tray(dotImage(undefined));
    } catch (error) {
      this.deps.onTrayUnavailable(error);
      return false;
    }

    this.tray.setToolTip('AI Usage Monitor');
    this.tray.on('click', () => this.togglePopover());
    // Right-click should feel the same rather than doing nothing.
    this.tray.on('right-click', () => this.togglePopover());
    return true;
  }

  /** Updates the icon and, on macOS, the text beside it. */
  render(display: MenuBarDisplay): void {
    if (this.tray === undefined) return;

    this.tray.setImage(dotImage(display.severity));
    this.tray.setToolTip(`${display.detail} — ${display.title}`);

    if (process.platform === 'darwin') {
      // A leading space separates the text from the icon; macOS does not add one.
      this.tray.setTitle(` ${display.title}`);
    }
  }

  private togglePopover(): void {
    if (this.popover !== undefined && this.popover.isVisible()) {
      this.popover.hide();
      return;
    }
    this.showPopover();
  }

  private showPopover(): void {
    const window = this.popover ?? this.createPopover();
    this.positionUnderTray(window);
    window.show();
    window.focus();
  }

  private createPopover(): BrowserWindow {
    const window = new BrowserWindow({
      width: POPOVER_WIDTH,
      height: POPOVER_HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      fullscreenable: false,
      // Rounded corners read as a popover rather than a stray window.
      transparent: process.platform === 'darwin',
      backgroundColor: process.platform === 'darwin' ? '#00000000' : '#0f172a',
      webPreferences: {
        preload: this.deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    // Dismiss on blur, the way a menu-bar popover is expected to behave.
    window.on('blur', () => window.hide());
    window.on('closed', () => {
      this.popover = undefined;
    });

    const query = 'view=popover';
    if (this.deps.rendererUrl !== undefined) {
      void window.loadURL(`${this.deps.rendererUrl}?${query}`);
    } else {
      void window.loadFile(this.deps.rendererFile, { search: query });
    }

    this.popover = window;
    return window;
  }

  /**
   * Anchors the popover under the status item.
   *
   * `tray.getBounds()` is empty on some Linux desktops, so it falls back to the top-right of
   * the work area rather than placing the window at 0,0.
   */
  private positionUnderTray(window: BrowserWindow): void {
    const bounds = this.tray?.getBounds();
    const display =
      bounds !== undefined && bounds.width > 0
        ? screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y })
        : screen.getPrimaryDisplay();
    const work = display.workArea;

    let x: number;
    let y: number;

    if (bounds !== undefined && bounds.width > 0) {
      x = Math.round(bounds.x + bounds.width / 2 - POPOVER_WIDTH / 2);
      y = Math.round(bounds.y + bounds.height + 4);
    } else {
      x = work.x + work.width - POPOVER_WIDTH - 8;
      y = work.y + 8;
    }

    // Keep it fully on screen when the item sits near a corner.
    x = Math.max(work.x + 8, Math.min(x, work.x + work.width - POPOVER_WIDTH - 8));
    y = Math.max(work.y + 8, Math.min(y, work.y + work.height - POPOVER_HEIGHT - 8));

    window.setBounds({ x, y, width: POPOVER_WIDTH, height: POPOVER_HEIGHT });
  }

  hidePopover(): void {
    this.popover?.hide();
  }

  destroy(): void {
    this.popover?.destroy();
    this.popover = undefined;
    this.tray?.destroy();
    this.tray = undefined;
  }
}

/** Resolves the packaged renderer entry, shared by the main window and the popover. */
export function rendererFilePath(): string {
  return join(app.getAppPath(), 'out', 'renderer', 'index.html');
}
