# AI Usage Monitor

A desktop app that shows how much of each of your AI **subscriptions** you have used —
5-hour, weekly and monthly — for every account, side by side.

Accounts run down the left. Each one gets three windows, and each window gets a progress
bar that runs **green**, turns **amber at 50%** and **red at 85%**.

```
┌─ AI Usage Monitor ─────────────────────── updated 9s ago ──┐
│ ACCOUNT              │ WINDOW                              │
├──────────────────────┼─────────────────────────────────────┤
│ ◆ Ed                 │ 5-hour   ███████░░░░░░░░░░   49%     │
│   ed@example.com     │          resets in 3h 1m            │
│   Claude · Pro       │ weekly   █░░░░░░░░░░░░░░░░    6%     │
│                      │          resets in 6d 2h            │
│                      │ monthly  ▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨    —      │
│                      │          no monthly spend cap set   │
│                      │          — $55.98 used this month   │
└──────────────────────┴─────────────────────────────────────┘
```

## Connecting an account

Press **Sign in**, approve in your browser, and the account appears. That is the whole flow.

If the provider's official client is not installed, the app shows you the exact command it
will run — published by the vendor — and installs it once you approve. Nothing is downloaded
or executed without you seeing it first.

It works this way deliberately. Anthropic does not issue OAuth credentials to third-party
applications, and its [terms](https://code.claude.com/docs/en/legal-and-compliance) prohibit
a third-party app from offering a "sign in with Claude" flow or using consumer OAuth tokens
elsewhere. So this app **never asks for your password, never runs an OAuth flow of its own,
and never uses API keys** — the provider's own client does the authenticating, in your
browser, and the app reads the session it wrote.

| Provider | Client | Signs in via | Session stored in |
|---|---|---|---|
| Claude | `claude` | browser | macOS **login Keychain**; a file in `~/.claude` elsewhere |
| ChatGPT | `codex` | browser | `~/.codex/auth.json` |
| OpenCode | `opencode` | browser (Claude Pro/Max or ChatGPT Plus/Pro) | `~/.local/share/opencode/auth.json` |

On macOS, Claude Code keeps its session in the login Keychain rather than on disk, so the
app reads it from there. macOS may ask you to allow that the first time. Because the
Keychain holds one entry per user rather than one per folder, a second Claude account added
by folder is only read from that folder — it is never attributed the default account's
session.

ChatGPT usage appears once Codex has actually run; signing in alone records nothing to
read.

The accounts panel also lets you rename an account, set its monthly spend cap, add a second
account of the same provider by pointing at its config folder, and stop tracking one.
Removing an account only stops this app watching it; the CLI session is left signed in.

## Menu bar

On macOS a status item sits in the upper right showing a coloured dot and a percentage —
green, amber past 50%, red past 85%. Click it for a popover with every connected account's
5-hour, weekly and monthly bars.

It tracks one of two things, your choice in the accounts panel:

- **Closest to its limit** — whichever account will run out first, across all windows.
- **A chosen account** — one account's 5-hour usage, always.

An account with no reading shows `—`, never `0%`. Windows and Linux get the same tray icon
and popover, with the figure in the tooltip, since only macOS draws text in the menu bar.

## Subscription authentication only

Credential files are opened read-only and are never written to.

**Sessions are kept fresh.** A subscription access token lasts hours, so the app tracks when
the one it holds expires. When it is close to or past that point, it runs the provider's own
read-only status command (`claude auth status`, `codex login status`), which makes the
official client refresh its session, and then re-reads it. The app cannot perform the OAuth
refresh itself — that needs the client's `client_id`, which no vendor issues to third parties
and which this project deliberately does not embed. The same recovery runs once if the server
rejects a session whose stored expiry looked fine, so a revoked token or a skewed clock does
not surface as "sign in again".

## Your data stays on your machine

Each installation gets a random identifier, written to `install-id` in the app's data folder
so it stays stable while installed. It is generated with `crypto.randomUUID()` — **not**
derived from any hardware or system value — and **it is never transmitted**. The app's only
outbound requests are to the provider usage endpoints.

**Remove all app data** in the accounts panel deletes everything the app created: your
account list, monthly caps and the install id. Your Claude, ChatGPT and OpenCode sessions are
left signed in, because this app did not create them — to sign out of those run
`claude auth logout`, `codex logout` or `opencode auth logout` yourself.

Windows removes the app data when you uninstall. **macOS has no uninstall hook at all** —
dragging an app to the Trash runs nothing — so use *Remove all app data* before deleting the
app, or remove the folder yourself:

```bash
rm -rf ~/Library/Application\ Support/ai-usage-monitor
```

## Supported providers

| Provider | Source | 5-hour | weekly | monthly |
|---|---|---|---|---|
| **Claude** | `GET /api/oauth/usage` with the claude.ai session | live | live | extra-usage credit spend |
| **ChatGPT** | rate-limit snapshots Codex records in `$CODEX_HOME/sessions` | live | live | credit balance |
| **OpenCode** | `auth.json` subscription logins | via the underlying subscription | " | " |

Two provider realities the app surfaces rather than hides:

- **Codex often records no rate limits at all.** Recent builds write `rate_limits: null`
  ([openai/codex#14880]), and the snapshots that do exist can lag hours behind. When there
  is no snapshot the row says so, and every value shows how old it is.
- **OpenCode has no quota of its own.** A profile signed in with Claude Pro draws from the
  *same* pool as your Claude account, so that row is marked `shares pool with …` instead of
  being counted twice.

Where a provider genuinely has no such window, or no cap to measure against, the row says
that plainly. **It never shows an empty green bar for something it could not measure** —
zero-green reads as "plenty left" when the truth is "no reading".

[openai/codex#14880]: https://github.com/openai/codex/issues/14880

## The monthly row

Subscriptions have no monthly token quota, so the monthly row tracks **extra-usage credit
spend** — real money. Providers usually report no cap for it, and without a cap there is no
denominator, so the row shows the amount spent as text rather than inventing a percentage.

Set a **monthly cap** for an account in the accounts panel and the row becomes a real bar
measured against it. A cap you set is labelled as yours, so a self-imposed budget is never
mistaken for a limit the provider enforces.

## Multiple accounts

Each account is bound to one config directory, and its bars are driven only by data read
from inside it. Three mechanisms keep a bar attached to its own account:

1. **Identity comes from the provider's subject** (account uuid, or the subject claim in
   the session), never from the label or the path — renaming or moving cannot re-point a bar.
2. **Reads are confined to one directory** by `AccountScope`, so two accounts cannot read
   each other's files even by accident.
3. **A mismatch is reported, not rendered.** If a directory is later signed in to a
   different account, the row refuses to show numbers that are not its own.

To watch a second account of the same provider, give it its own config directory and add it
to the config file (**Manage accounts** in the footer):

```jsonc
{
  "version": 1,
  "pollSeconds": 60,
  "accounts": [
    { "id": "claude:<account-uuid>", "provider": "claude",  "label": "Personal", "configDir": "~/.claude" },
    { "id": "claude:<account-uuid>", "provider": "claude",  "label": "Work",     "configDir": "~/.claude-work" },
    { "id": "chatgpt:<subject>",     "provider": "chatgpt", "label": "ChatGPT",  "configDir": "~/.codex" }
  ]
}
```

Run the CLI with `CLAUDE_CONFIG_DIR` / `CODEX_HOME` pointed at that directory to sign the
second account in. Unknown or malformed keys are reported rather than silently dropped.

## Install

Download the artifact for your platform from the release, or build it yourself:

```bash
pnpm install
pnpm dev            # run in development
pnpm test           # unit tests
pnpm build:linux    # or build:win / build:mac
```

`pnpm build` runs typecheck and tests before packaging.

macOS and Windows installers can only be produced on their own operating systems, which is
why the release runs as a three-OS GitHub Actions matrix.

### First launch on macOS

The app is **ad-hoc signed but not notarised** — notarisation needs a paid Apple Developer
certificate. Ad-hoc signing is what makes it runnable at all: macOS refuses to execute
unsigned arm64 code outright. Gatekeeper is a separate gate, and because the download is
quarantined and unnotarised, it blocks the first launch. One deliberate action clears it,
permanently.

macOS 15 (Sequoia) **removed the old Control-click → Open shortcut**, so on current macOS:

1. Open the app once and let it be refused (`"AI Usage Monitor" Not Opened`).
2. Go to **System Settings → Privacy & Security**, scroll to **Security**.
3. Click **Open Anyway** next to AI Usage Monitor, then confirm.

On macOS 14 and earlier, right-click the app and choose **Open** instead.

Either way, macOS remembers the decision and later launches are normal.

**Or do it in one command**, which works on every macOS version — it strips the quarantine
flag that Finder attached when the file was downloaded:

```bash
xattr -dr com.apple.quarantine "/Applications/AI Usage Monitor.app"
```

There is one download for macOS. It is a **universal** build containing both `arm64` and
`x86_64`, so it runs natively on Apple Silicon (M1, M2, M3, M4) and on Intel, and there is
no architecture to pick wrongly. It requires macOS 11 Big Sur or later.

> **Windows** shows a SmartScreen warning for the same reason — choose **More info →
> Run anyway**. Signing and notarising both platforms needs certificates; the build is
> already configured so that adding them changes nothing else.

## How it is put together

```
src/shared/    pure domain — severity thresholds, window states, formatting. No I/O.
src/main/      Electron main: the only place credentials or the network are touched.
  providers/   one adapter per provider, each confined to a single AccountScope
src/preload/   the entire renderer-facing surface (sandboxed, context-isolated)
src/renderer/  React UI
```

The renderer is treated as untrusted: sandboxed, context-isolated, no Node, blocked from
navigating, and served under a CSP with `connect-src 'none'` — it cannot reach the network
even if it tried. Tokens never cross the IPC boundary, and the logger redacts secrets on
every line it writes.

Run the live probe against your real accounts at any time:

```bash
pnpm exec vitest run --config scripts/vitest.live.config.ts --disableConsoleIntercept
```
