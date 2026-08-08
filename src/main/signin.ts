/**
 * Sign-in orchestration: install if needed, hand off to the browser, then detect the session.
 *
 * The app performs no authentication itself. It starts the provider's own CLI, watches for
 * the URL that CLI prints, opens that URL in the user's browser, and then waits for the
 * session file the CLI writes. The credential is created by the official client and never
 * passes through this process.
 *
 * The sign-in URL is treated as a secret in flight: it carries an authorization code and
 * state, so it goes straight to the browser and is never logged, shown, or persisted.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { Provider } from '@shared/account';
import type { SignInPhase, SignInProgress } from '@shared/ipc';
import type { AccountManager } from './accounts';
import { PROVIDER_CLIS, findCli, launchLogin } from './cli';
import { installCommandFor, runInstall } from './installer';
import { redact, type Logger } from './logger';
import { messageOf } from './scope';

/** How long to wait for the user to finish in the browser before giving up. */
const DETECT_TIMEOUT_MS = 3 * 60 * 1000;
const DETECT_INTERVAL_MS = 2_500;

/** Anything that looks like a URL the CLI wants opened. */
const URL_PATTERN = /https?:\/\/[^\s'"]+/;

export interface SignInHooks {
  readonly onProgress: (progress: SignInProgress) => void;
  /** Opens the provider's authorization page. Receives a secret URL; must not log it. */
  readonly openExternal: (url: string) => Promise<void>;
}

export interface SignInOptions {
  readonly provider: Provider;
  /** True when the user has already approved running the vendor's installer. */
  readonly installApproved: boolean;
}

export type SignInResult =
  | { readonly ok: true; readonly detail: string }
  | { readonly ok: false; readonly reason: string; readonly needsInstallApproval?: true };

export class SignInService {
  private active: ChildProcess | undefined;

  constructor(
    private readonly accounts: AccountManager,
    private readonly logger: Logger,
  ) {}

  /** Aborts an in-flight sign-in. The provider's own flow in the browser is unaffected. */
  cancel(): void {
    this.active?.kill();
    this.active = undefined;
  }

  async signIn(options: SignInOptions, hooks: SignInHooks): Promise<SignInResult> {
    const { provider } = options;
    const cli = PROVIDER_CLIS[provider];

    const report = (phase: SignInPhase, message: string): void =>
      hooks.onProgress({ provider, phase, message });

    report('checking', `Looking for ${cli.command}…`);
    let executable = await findCli(cli.command);

    if (executable === undefined) {
      const command = installCommandFor(provider, process.platform);
      if (command === undefined) {
        return { ok: false, reason: `No installer is published for ${cli.command} on this platform.` };
      }
      if (!options.installApproved) {
        // The user approves the exact command before anything runs.
        return {
          ok: false,
          reason: command.display,
          needsInstallApproval: true,
        };
      }

      report('installing', `Installing ${cli.command}…`);
      const installed = await runInstall(command, this.logger, (line) => report('installing', line));
      if (!installed.ok) {
        return { ok: false, reason: `Could not install ${cli.command}: ${installed.reason}` };
      }

      executable = await findCli(cli.command);
      if (executable === undefined) {
        return {
          ok: false,
          reason: `${cli.command} installed, but its binary was not found in any of the usual locations. Some installers only add themselves to your shell profile, which an app does not read. Open a terminal, confirm \`${cli.command}\` runs, then press "Detect accounts".`,
        };
      }
    }

    report('awaiting-approval', 'Opening your browser to sign in…');
    const started = await this.startBrowserSignIn(provider, executable, hooks, report);
    if (!started.ok) return started;

    report('detecting', 'Waiting for the session…');
    return this.waitForAccount(provider, report);
  }

  /**
   * Runs the CLI's login and opens whatever URL it prints.
   *
   * Some of these CLIs are full terminal UIs and refuse to run without a TTY. Rather than
   * guess which, this starts headless and falls back to a real terminal window the moment
   * the process signals it cannot proceed — the browser still does the authenticating either
   * way.
   */
  private async startBrowserSignIn(
    provider: Provider,
    executable: string,
    hooks: SignInHooks,
    report: (phase: SignInPhase, message: string) => void,
  ): Promise<SignInResult> {
    const cli = PROVIDER_CLIS[provider];

    let child: ChildProcess;
    try {
      child = spawn(executable, [...cli.loginArgs], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    } catch (error) {
      return this.fallBackToTerminal(provider, `could not start ${cli.command}: ${messageOf(error)}`, report);
    }

    this.active = child;
    let openedUrl = false;
    let sawTtyComplaint = false;

    const inspect = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');

      // A TTY complaint means this CLI needs a real terminal; note it for the fallback.
      if (/not a (tty|terminal)|requires a (tty|terminal)|raw mode|stdin is not/i.test(text)) {
        sawTtyComplaint = true;
      }

      const match = URL_PATTERN.exec(text);
      if (match !== null && !openedUrl) {
        openedUrl = true;
        // Deliberately not logged: this URL carries the authorization code and state.
        void hooks.openExternal(match[0]);
        report('awaiting-approval', 'Approve the sign-in in your browser, then come back.');
      }

      // Everything else is safe to surface only after redaction.
      for (const line of text.split('\n')) {
        const clean = redact(line.trimEnd());
        if (clean.length > 0 && !URL_PATTERN.test(clean)) report('awaiting-approval', clean);
      }
    };

    child.stdout?.on('data', inspect);
    child.stderr?.on('data', inspect);

    /*
     * Three outcomes matter here, and an earlier version conflated two of them.
     *
     * Some clients print a URL for us to open. Others — Claude Code among them — open the
     * browser themselves and print nothing, then sit waiting for the callback. Treating
     * "no URL seen" as failure meant a sign-in that was working perfectly also got a
     * terminal thrown at it, so the only real signal is whether the process is still alive.
     */
    type Outcome = { kind: 'exited'; code: number | null } | { kind: 'running' } | { kind: 'failed' };

    const outcome = await new Promise<Outcome>((resolve) => {
      child.on('error', () => resolve({ kind: 'failed' }));
      child.on('close', (code) => resolve({ kind: 'exited', code }));
      setTimeout(() => resolve(child.exitCode === null ? { kind: 'running' } : { kind: 'exited', code: child.exitCode }), 15_000);
    });

    if (outcome.kind === 'running' || openedUrl) {
      // Still waiting on the browser, or we opened the page ourselves. Either way the
      // authentication is under way and detection is what confirms it.
      if (!openedUrl) {
        report('awaiting-approval', 'Approve the sign-in in your browser, then come back.');
      }
      return { ok: true, detail: 'browser opened' };
    }

    // It exited without ever getting a browser involved. A zero exit here usually means the
    // client refused to run without a terminal.
    if (sawTtyComplaint || outcome.kind === 'failed' || outcome.code !== 0) {
      return this.fallBackToTerminal(provider, 'the client needs a terminal to sign in', report);
    }

    // Exited cleanly with no browser step: it may already have been signed in.
    return { ok: true, detail: 'sign-in completed' };
  }

  /** Opens a real terminal running the provider's sign-in, for CLIs that need a TTY. */
  private async fallBackToTerminal(
    provider: Provider,
    why: string,
    report: (phase: SignInPhase, message: string) => void,
  ): Promise<SignInResult> {
    this.logger.info(`falling back to a terminal for ${provider}: ${why}`);
    report('awaiting-approval', 'Opening a terminal to finish signing in…');

    const launched = await launchLogin(provider, this.logger);
    if (!launched.ok) return { ok: false, reason: launched.reason };

    report(
      'awaiting-approval',
      provider === 'opencode'
        ? 'Choose your provider in the terminal — Claude Pro/Max for usage figures — and your browser will open.'
        : 'Finish signing in through the terminal and your browser.',
    );
    return { ok: true, detail: launched.detail };
  }

  /** Polls until the provider's session appears and the account registers itself. */
  private async waitForAccount(
    provider: Provider,
    report: (phase: SignInPhase, message: string) => void,
  ): Promise<SignInResult> {
    const deadline = Date.now() + DETECT_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const result = await this.accounts.detect();
      const added = result.added.find((account) => account.provider === provider);
      if (added !== undefined) {
        report('done', `Connected ${added.label}.`);
        return { ok: true, detail: `Connected ${added.label}.` };
      }
      await sleep(DETECT_INTERVAL_MS);
    }

    return {
      ok: false,
      reason:
        'Timed out waiting for the sign-in. If you finished in the browser, press "Detect accounts" — the session may just have landed late.',
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
