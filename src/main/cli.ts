/**
 * Provider CLI discovery and sign-in.
 *
 * Anthropic and OpenAI do not issue OAuth client credentials to third-party applications,
 * and Anthropic's terms explicitly forbid a third-party app from offering a "sign in with
 * Claude" flow of its own. So this app never asks for credentials and never runs an OAuth
 * flow: pressing Connect launches the provider's *own* CLI in a terminal, the user
 * authenticates in that official tool, and the app then detects the session it wrote.
 *
 * Nothing here reads or transmits a credential. It locates an executable and opens a
 * terminal; the provider's tooling does the rest.
 */

import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type { Provider } from '@shared/account';
import type { Logger } from './logger';
import { messageOf } from './scope';

/** How each provider's CLI is found and how it is told to sign in. */
interface ProviderCli {
  /** Executable name, without extension. */
  readonly command: string;
  /** Arguments that start an interactive sign-in. */
  readonly loginArgs: readonly string[];
  /**
   * A read-only status command.
   *
   * Running it asks the official client to check its own session, which is what refreshes an
   * expired access token. This app cannot perform an OAuth refresh itself: that needs the
   * client's OAuth client_id, which no vendor issues to third parties and which this project
   * deliberately does not embed. Letting the client do it keeps the token valid without
   * anyone impersonating anyone.
   */
  readonly statusArgs: readonly string[];
  /** Where to send the user when the CLI is not installed. */
  readonly installUrl: string;
}

export const PROVIDER_CLIS: Readonly<Record<Provider, ProviderCli>> = {
  // Verified against `claude --help` / `claude auth --help`.
  claude: {
    command: 'claude',
    loginArgs: ['auth', 'login'],
    // Verified against `claude auth status --help`.
    statusArgs: ['auth', 'status', '--json'],
    installUrl: 'https://claude.com/download',
  },
  // Verified against `codex login --help`; bare `codex login` starts the flow.
  chatgpt: {
    command: 'codex',
    loginArgs: ['login'],
    // Verified against `codex login status --help`.
    statusArgs: ['login', 'status'],
    installUrl: 'https://developers.openai.com/codex/cli',
  },
  // Verified against the installed binary: `opencode providers` carries the alias `auth`,
  // with subcommands list/login/logout. `auth list` is non-interactive and prints the path
  // to auth.json, which is also how the data directory was confirmed.
  opencode: {
    command: 'opencode',
    loginArgs: ['auth', 'login'],
    statusArgs: ['auth', 'list'],
    installUrl: 'https://opencode.ai/docs',
  },
};

export interface CliStatus {
  readonly provider: Provider;
  readonly command: string;
  readonly installed: boolean;
  readonly path?: string;
  readonly installUrl: string;
}

/**
 * Directories a GUI app must search itself.
 *
 * An app launched from Finder or the Start menu does not inherit the shell's PATH, so a CLI
 * installed by a version manager or into ~/.local/bin is invisible unless these are checked
 * explicitly. Reporting "not installed" for a tool the user can run in their terminal would
 * be the most confusing possible error.
 */
function candidateDirectories(): string[] {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '';
  const fromPath = (process.env['PATH'] ?? '').split(delimiter).filter((entry) => entry !== '');

  if (process.platform === 'win32') {
    return fromPath;
  }

  const system = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'];
  const perUser =
    home === ''
      ? []
      : [
          join(home, '.local', 'bin'),
          join(home, 'bin'),
          join(home, '.bun', 'bin'),
          join(home, '.deno', 'bin'),
          join(home, '.npm-global', 'bin'),
          join(home, '.volta', 'bin'),
          /*
           * Vendor installers that place a binary outside the usual locations and only add
           * it to a shell rc file. A GUI app never sources those, so without these entries
           * a freshly installed client is reported as missing — which is exactly what
           * OpenCode did: its installer uses $HOME/.opencode/bin and appends that to the
           * user's shell profile.
           */
          join(home, '.opencode', 'bin'),
          join(home, '.codex', 'bin'),
        ];

  return [...fromPath, ...system, ...perUser];
}

const WINDOWS_EXTENSIONS = ['.cmd', '.exe', '.bat', ''];

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Finds a CLI on disk, searching beyond the inherited PATH. */
export async function findCli(command: string): Promise<string | undefined> {
  const seen = new Set<string>();
  for (const directory of candidateDirectories()) {
    if (directory === '' || seen.has(directory)) continue;
    seen.add(directory);

    const extensions = process.platform === 'win32' ? WINDOWS_EXTENSIONS : [''];
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

export async function statusFor(provider: Provider): Promise<CliStatus> {
  const cli = PROVIDER_CLIS[provider];
  const path = await findCli(cli.command);
  return {
    provider,
    command: cli.command,
    installed: path !== undefined,
    installUrl: cli.installUrl,
    ...(path === undefined ? {} : { path }),
  };
}

export async function allStatuses(): Promise<CliStatus[]> {
  return Promise.all((Object.keys(PROVIDER_CLIS) as Provider[]).map(statusFor));
}

/** A status check should be quick; a hung CLI must not stall a poll. */
const STATUS_TIMEOUT_MS = 20_000;

/**
 * Asks the provider's own client to check — and thereby refresh — its session.
 *
 * Output is discarded. The point is the side effect: the official client notices its access
 * token has expired and exchanges its refresh token, updating the session in place. The app
 * then re-reads it. Nothing here handles a token.
 */
export async function refreshSessionViaCli(provider: Provider, logger: Logger): Promise<boolean> {
  const cli = PROVIDER_CLIS[provider];
  const executable = await findCli(cli.command);
  if (executable === undefined) return false;

  return new Promise<boolean>((resolve) => {
    const child = spawn(executable, [...cli.statusArgs], { stdio: 'ignore', env: process.env });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, STATUS_TIMEOUT_MS);

    child.on('error', (error) => {
      clearTimeout(timer);
      logger.warn(`could not run ${cli.command} ${cli.statusArgs.join(' ')}:`, error);
      resolve(false);
    });
    // Even a non-zero exit may have refreshed the session, so the caller re-reads regardless.
    child.on('close', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Launching an interactive sign-in                                            */
/* -------------------------------------------------------------------------- */

/**
 * Quotes a string for a POSIX shell by wrapping it in single quotes.
 *
 * The command line is assembled from a path found on disk, which can legitimately contain
 * spaces, so it cannot be interpolated raw.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Escapes a string for embedding in an AppleScript double-quoted literal. */
function appleScriptQuote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

const LINUX_TERMINALS: readonly { command: string; args: (cmd: string) => string[] }[] = [
  { command: 'x-terminal-emulator', args: (cmd) => ['-e', 'bash', '-lc', cmd] },
  { command: 'gnome-terminal', args: (cmd) => ['--', 'bash', '-lc', cmd] },
  { command: 'konsole', args: (cmd) => ['-e', 'bash', '-lc', cmd] },
  { command: 'xfce4-terminal', args: (cmd) => ['-e', `bash -lc ${shellQuote(cmd)}`] },
  { command: 'alacritty', args: (cmd) => ['-e', 'bash', '-lc', cmd] },
  { command: 'kitty', args: (cmd) => ['bash', '-lc', cmd] },
  { command: 'xterm', args: (cmd) => ['-e', 'bash', '-lc', cmd] },
];

export type LaunchResult = { ok: true; detail: string } | { ok: false; reason: string };

/**
 * Opens a terminal running the provider's sign-in command.
 *
 * The terminal is left open after the command finishes so the user can read what happened —
 * these flows print URLs and confirmation text that would vanish with the window.
 */
export async function launchLogin(provider: Provider, logger: Logger): Promise<LaunchResult> {
  const cli = PROVIDER_CLIS[provider];
  const executable = await findCli(cli.command);
  if (executable === undefined) {
    return {
      ok: false,
      reason: `${cli.command} is not installed. Install it from ${cli.installUrl}, then try again.`,
    };
  }

  // `exec bash` keeps the window alive after the CLI exits.
  const inner = [executable, ...cli.loginArgs].map(shellQuote).join(' ');
  const commandLine = `${inner}; echo; echo "You can close this window and return to AI Usage Monitor."; exec bash`;

  try {
    if (process.platform === 'darwin') {
      const script = `tell application "Terminal"\nactivate\ndo script "${appleScriptQuote(commandLine)}"\nend tell`;
      spawnDetached('/usr/bin/osascript', ['-e', script], logger);
      return { ok: true, detail: 'Terminal opened' };
    }

    if (process.platform === 'win32') {
      const windowsCommand = [executable, ...cli.loginArgs].map((part) => `"${part}"`).join(' ');
      spawnDetached('cmd.exe', ['/c', 'start', '""', 'cmd', '/k', windowsCommand], logger);
      return { ok: true, detail: 'Command Prompt opened' };
    }

    for (const terminal of LINUX_TERMINALS) {
      const found = await findCli(terminal.command);
      if (found === undefined) continue;
      spawnDetached(found, terminal.args(commandLine), logger);
      return { ok: true, detail: `${terminal.command} opened` };
    }

    return {
      ok: false,
      reason: `No terminal emulator found. Run \`${cli.command} ${cli.loginArgs.join(' ')}\` yourself, then press Refresh.`,
    };
  } catch (error) {
    logger.error(`failed to launch ${cli.command} sign-in:`, error);
    return {
      ok: false,
      reason: `Could not open a terminal: ${messageOf(error)}. Run \`${cli.command} ${cli.loginArgs.join(' ')}\` yourself, then press Refresh.`,
    };
  }
}

/** Starts a process that outlives this one, so closing the app does not kill the sign-in. */
function spawnDetached(command: string, args: readonly string[], logger: Logger): void {
  const child = spawn(command, [...args], { detached: true, stdio: 'ignore' });
  child.on('error', (error) => logger.error(`terminal launch failed (${command}):`, error));
  child.unref();
}
