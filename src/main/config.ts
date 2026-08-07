/**
 * Configuration file: which accounts to watch and how often.
 *
 * Validation is strict on purpose. A typo silently dropped from a config file becomes a
 * bar that quietly watches the wrong thing, so an unknown or malformed key is reported to
 * the user instead of being discarded.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ConfigSchema, DEFAULT_CONFIG, type AppConfig } from '@shared/config';
import { messageOf } from './scope';

export interface LoadResult {
  readonly config: AppConfig;
  /** Set when the file existed but could not be used; the defaults are in effect meanwhile. */
  readonly error?: string;
}

export class ConfigStore {
  constructor(readonly filePath: string) {}

  async load(): Promise<LoadResult> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return { config: DEFAULT_CONFIG };
      return { config: DEFAULT_CONFIG, error: `could not read ${this.filePath}: ${messageOf(error)}` };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      return { config: DEFAULT_CONFIG, error: `${this.filePath} is not valid JSON: ${messageOf(error)}` };
    }

    const parsed = ConfigSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        config: DEFAULT_CONFIG,
        error: `${this.filePath} is not a valid config: ${formatIssues(parsed.error)}`,
      };
    }

    return { config: parsed.data };
  }

  /** Writes via a temporary file and rename so an interrupted write cannot truncate the config. */
  async save(config: AppConfig): Promise<void> {
    const validated = ConfigSchema.parse(config);
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}

function formatIssues(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT';
}
