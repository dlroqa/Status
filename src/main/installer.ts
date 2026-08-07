/**
 * Installing a provider's official CLI.
 *
 * The app drives the vendors' own clients rather than authenticating itself, so pressing
 * "Sign in" has to be able to put that client on disk. Every command below is the vendor's
 * own documented installer, quoted from their published docs — nothing is assembled from
 * guesswork, and nothing is downloaded from anywhere but the vendor.
 *
 * The exact command is always shown to the user for approval before it runs. An app that
 * silently pipes a remote script into a shell is not something to build by default.
 */

import { spawn } from 'node:child_process';
import type { Provider } from '@shared/account';
import { redact, type Logger } from './logger';
import { messageOf } from './scope';

export interface InstallCommand {
  /** Human-readable, exactly as shown to the user before they approve it. */
  readonly display: string;
  /** Executable to run. */
  readonly file: string;
  readonly args: readonly string[];
  /** Where the command comes from, shown so the source is checkable. */
  readonly documentation: string;
}

/**
 * Official install commands, per provider and platform.
 *
 * Sources:
 *  - Claude:   https://code.claude.com/docs/en/setup  ("Native Install (Recommended)")
 *  - Codex:    https://learn.chatgpt.com/docs/codex/cli
 *  - OpenCode: https://opencode.ai/docs
 */
export function installCommandFor(provider: Provider, platform: NodeJS.Platform): InstallCommand | undefined {
  const windows = platform === 'win32';

  switch (provider) {
    case 'claude':
      return windows
        ? {
            display: 'irm https://claude.ai/install.ps1 | iex',
            file: 'powershell.exe',
            args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex'],
            documentation: 'https://code.claude.com/docs/en/setup',
          }
        : {
            display: 'curl -fsSL https://claude.ai/install.sh | bash',
            file: 'bash',
            args: ['-lc', 'curl -fsSL https://claude.ai/install.sh | bash'],
            documentation: 'https://code.claude.com/docs/en/setup',
          };

    case 'chatgpt':
      // The vendor documents a shell installer for macOS/Linux only; npm is the documented
      // route elsewhere, and requires npm to be present.
      return windows
        ? {
            display: 'npm install -g @openai/codex',
            file: 'npm.cmd',
            args: ['install', '-g', '@openai/codex'],
            documentation: 'https://learn.chatgpt.com/docs/codex/cli',
          }
        : {
            display: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
            file: 'bash',
            args: ['-lc', 'curl -fsSL https://chatgpt.com/codex/install.sh | sh'],
            documentation: 'https://learn.chatgpt.com/docs/codex/cli',
          };

    case 'opencode':
      return windows
        ? {
            display: 'npm install -g opencode-ai',
            file: 'npm.cmd',
            args: ['install', '-g', 'opencode-ai'],
            documentation: 'https://opencode.ai/docs',
          }
        : {
            display: 'curl -fsSL https://opencode.ai/install | bash',
            file: 'bash',
            args: ['-lc', 'curl -fsSL https://opencode.ai/install | bash'],
            documentation: 'https://opencode.ai/docs',
          };
  }
}

export type InstallResult = { ok: true } | { ok: false; reason: string };

/** How long an install may take before it is treated as stuck. */
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Runs an install command, streaming its output.
 *
 * Output passes through `redact` before it reaches the caller: installers echo their
 * commands, and a shell line is the last place a token should be able to surface.
 */
export async function runInstall(
  command: InstallCommand,
  logger: Logger,
  onOutput: (line: string) => void,
): Promise<InstallResult> {
  return new Promise<InstallResult>((resolve) => {
    let child;
    try {
      child = spawn(command.file, [...command.args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (error) {
      resolve({ ok: false, reason: `could not start the installer: ${messageOf(error)}` });
      return;
    }

    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, reason: `the installer did not finish within ${INSTALL_TIMEOUT_MS / 60_000} minutes` });
    }, INSTALL_TIMEOUT_MS);

    const emit = (chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split('\n')) {
        const clean = redact(line.trimEnd());
        if (clean.length > 0) onOutput(clean);
      }
    };

    child.stdout?.on('data', emit);
    child.stderr?.on('data', emit);

    child.on('error', (error) => {
      clearTimeout(timer);
      logger.error(`installer failed (${command.file}):`, error);
      resolve({ ok: false, reason: messageOf(error) });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(
        code === 0
          ? { ok: true }
          : { ok: false, reason: `the installer exited with status ${code ?? 'unknown'}` },
      );
    });
  });
}
