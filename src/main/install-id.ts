/**
 * Per-installation identity.
 *
 * A random identifier that stays stable for as long as this installation exists, so the app
 * can distinguish "this install" from a fresh one after removal and reinstall.
 *
 * Two properties matter, and both are deliberate:
 *
 *  - It is **random**, from `crypto.randomUUID()` — not derived from a MAC address, serial
 *    number, hostname or any other system value. It therefore cannot be correlated back to
 *    the machine, or to a different install on the same machine.
 *  - It is **local**. Nothing transmits it. The app's only outbound requests are the
 *    provider usage endpoints, which carry the provider's own Authorization header and
 *    nothing else, and a test asserts this module is not referenced from the HTTP layer.
 *
 * It lives in its own file rather than inside config.json so that editing or resetting
 * configuration does not silently mint a new identity.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { messageOf } from './scope';

/** A v4 UUID, the only shape this file is ever allowed to hold. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class InstallIdentity {
  private cached: string | undefined;

  constructor(readonly filePath: string) {}

  /**
   * Returns the identity, creating it on first use.
   *
   * A corrupt or truncated file is replaced rather than propagated: an identity that is not
   * a UUID is not an identity, and keeping it would only push the failure somewhere less
   * obvious.
   */
  async read(): Promise<string> {
    if (this.cached !== undefined) return this.cached;

    const existing = await this.readExisting();
    if (existing !== undefined) {
      this.cached = existing;
      return existing;
    }

    const created = randomUUID();
    await this.write(created);
    this.cached = created;
    return created;
  }

  private async readExisting(): Promise<string | undefined> {
    try {
      const contents = (await readFile(this.filePath, 'utf8')).trim();
      return UUID_PATTERN.test(contents) ? contents : undefined;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw new Error(`could not read the install id: ${messageOf(error)}`);
    }
  }

  /** Written via a temporary file and rename so an interrupted write cannot truncate it. */
  private async write(value: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, `${value}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
  }

  /** Removes the identity. A later read mints a new one, which is what a fresh install means. */
  async remove(): Promise<void> {
    this.cached = undefined;
    await rm(this.filePath, { force: true });
    await rm(`${this.filePath}.tmp`, { force: true });
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT';
}
