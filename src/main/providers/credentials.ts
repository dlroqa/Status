/**
 * Where a provider's session actually lives, which is not the same on every platform.
 *
 * Claude Code writes `~/.claude/.credentials.json` on Linux and Windows, but on macOS it
 * stores the same JSON in the login Keychain instead. Reading only the file meant that on a
 * Mac the browser sign-in would succeed and the app would then find nothing at all — the
 * failure looked like "nothing happened" because nothing did.
 *
 * Credentials read here are handed straight to the request that needs them. Nothing is
 * cached, logged, or written back.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AccountScope } from '../scope';

const run = promisify(execFile);

/** Service name Claude Code files its credentials under in the macOS Keychain. */
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

export type CredentialLookup =
  | { readonly found: true; readonly value: unknown; readonly source: string }
  | { readonly found: false; readonly reason?: string };

/** Reads the credentials file inside the account's own directory. */
export async function readCredentialsFile(
  scope: AccountScope,
  fileName: string,
): Promise<CredentialLookup> {
  const raw = await scope.readJson(fileName);
  if (raw === undefined) return { found: false };
  if (!raw.ok) return { found: false, reason: raw.reason };
  return { found: true, value: raw.value, source: fileName };
}

/**
 * Reads Claude Code's credentials from the macOS login Keychain.
 *
 * `security` prompts for Keychain access the first time and then remembers the decision, so
 * this can legitimately fail with the user having denied it — which is reported rather than
 * treated as "not signed in", because the two need different fixes.
 */
export async function readMacKeychainCredentials(): Promise<CredentialLookup> {
  if (process.platform !== 'darwin') return { found: false };

  try {
    // -w prints only the password, so nothing else about the item reaches this process.
    const { stdout } = await run('/usr/bin/security', [
      'find-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-w',
    ]);

    const text = stdout.trim();
    if (text.length === 0) return { found: false };

    try {
      return { found: true, value: JSON.parse(text) as unknown, source: 'macOS Keychain' };
    } catch {
      return { found: false, reason: 'the Keychain entry is not valid JSON' };
    }
  } catch (error) {
    // Exit status 44 is "item not found", which simply means not signed in this way.
    const status = (error as { code?: number }).code;
    if (status === 44) return { found: false };
    return {
      found: false,
      reason:
        'macOS refused access to the Claude Code Keychain item. Allow access when prompted, or run `claude auth login` once in a terminal.',
    };
  }
}
