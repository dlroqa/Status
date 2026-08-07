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

## Subscription authentication only

The app reads the OAuth sessions your CLIs already hold. **No API keys are used or
accepted**, and metered API accounts are deliberately excluded — they have no usage
windows to show. Credential files are opened read-only and are never written to:
refreshing a token behind a CLI's back could invalidate your login, so an expired session
is reported for you to fix rather than repaired.

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
to the config file (**Edit accounts** in the footer):

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

Releases are **ad-hoc signed, not notarised** — they carry no Apple Developer identity,
because that needs a paid certificate. Ad-hoc signing is what makes the app runnable at
all: macOS refuses to execute unsigned arm64 code outright, which is why a truly unsigned
build shows a crossed-out icon in Finder instead of a prompt.

Gatekeeper is a separate gate. Because the download is quarantined and the app is not
notarised, the first launch needs one deliberate action:

**Right-click the app in Applications and choose Open**, then confirm. macOS remembers the
choice, so this is a one-time step. (Double-clicking will refuse — use Open from the
right-click menu.)

If macOS still refuses, clear the quarantine flag it set on download:

```bash
xattr -dr com.apple.quarantine "/Applications/AI Usage Monitor.app"
```

Download the build matching your Mac: `arm64` for Apple Silicon, the plain build for Intel.

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
