/**
 * A read-only view of exactly one account's config directory.
 *
 * Every adapter is handed one scope and can only read through it. Two accounts of the same
 * provider therefore cannot read each other's files even by accident, which is what keeps a
 * progress bar bound to the account it belongs to. Nothing here can write.
 */

import { open, readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

/** Expands a leading `~` and resolves to an absolute path. */
export function expandHome(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith(`~${sep}`) || trimmed.startsWith('~/')) {
    return resolve(homedir(), trimmed.slice(2));
  }
  return resolve(trimmed);
}

export class PathEscapeError extends Error {
  constructor(requested: string, root: string) {
    super(`refusing to read ${requested}: outside the account scope ${root}`);
    this.name = 'PathEscapeError';
  }
}

export class AccountScope {
  /** Absolute, resolved config directory for this account. */
  readonly root: string;

  /**
   * Absolute paths outside `root` that this scope may also read. Providers that keep a
   * companion file next to their config directory register it explicitly, so the exception
   * is visible in code rather than hidden behind a `..` traversal.
   */
  private readonly companions: ReadonlySet<string>;

  constructor(configDir: string, companionFiles: readonly string[] = []) {
    this.root = expandHome(configDir);
    this.companions = new Set(companionFiles.map((file) => expandHome(file)));
  }

  /** Resolves a path relative to the root, rejecting anything that escapes it. */
  resolveWithin(...segments: string[]): string {
    const target = resolve(this.root, join(...segments));
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new PathEscapeError(target, this.root);
    }
    return target;
  }

  private authorise(target: string): string {
    if (isAbsolute(target) && this.companions.has(resolve(target))) return resolve(target);
    return this.resolveWithin(target);
  }

  /** True when the scope's directory exists. */
  async exists(): Promise<boolean> {
    return this.isDirectory(this.root);
  }

  private async isDirectory(target: string): Promise<boolean> {
    try {
      const stats = await stat(target);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  /** Reads a UTF-8 file, returning undefined when it does not exist. */
  async readText(target: string): Promise<string | undefined> {
    const authorised = this.authorise(target);
    try {
      return await readFile(authorised, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  /**
   * Reads and parses JSON. A malformed file is reported as a distinct failure rather than
   * being treated as missing, because "your credentials file is corrupt" and "you are not
   * logged in" call for completely different fixes.
   */
  async readJson(target: string): Promise<{ ok: true; value: unknown } | { ok: false; reason: string } | undefined> {
    const text = await this.readText(target);
    if (text === undefined) return undefined;
    try {
      return { ok: true, value: JSON.parse(text) as unknown };
    } catch (error) {
      return { ok: false, reason: `${target} is not valid JSON: ${messageOf(error)}` };
    }
  }

  /**
   * Reads the last `maxBytes` of a file as UTF-8.
   *
   * Session logs grow without bound and only their newest entries matter, so reading the
   * whole file would waste memory for no gain. A partial first line is dropped by the
   * caller, which parses line-by-line and ignores unparseable lines.
   */
  async readTailText(target: string, maxBytes: number): Promise<string | undefined> {
    const authorised = this.authorise(target);
    let handle;
    try {
      handle = await open(authorised, 'r');
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, maxBytes);
      const start = size - length;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      return buffer.toString('utf8');
    } finally {
      await handle.close();
    }
  }

  /** Lists files under a directory in the scope, recursing depth-first. Missing dirs yield []. */
  async listFiles(relativeDir: string, options: { extension?: string } = {}): Promise<string[]> {
    const start = this.resolveWithin(relativeDir);
    const found: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (isNotFound(error)) return;
        throw error;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile()) {
          if (options.extension === undefined || entry.name.endsWith(options.extension)) {
            found.push(full);
          }
        }
      }
    };

    await walk(start);
    return found;
  }

  /** Modification time, used to read newest-first without parsing every file. */
  async modifiedAt(absolutePath: string): Promise<number | undefined> {
    try {
      const stats = await stat(this.authorise(absolutePath));
      return stats.mtimeMs;
    } catch {
      return undefined;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT';
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
