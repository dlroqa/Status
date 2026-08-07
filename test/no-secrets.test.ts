import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Repository-wide secret scan.
 *
 * The app never obtains, stores or transmits a credential of its own, and this is where that
 * claim is checked rather than trusted. It runs inside `pnpm test`, so the release workflow
 * blocks on it.
 *
 * There is deliberately **no allowlist**. An exception is a place for a real secret to hide,
 * so anything that trips these patterns has to be rewritten rather than excused — which is
 * why the OpenCode fixture uses a placeholder that is not key-shaped.
 */

const ROOT = resolve(__dirname, '..');

/** Files whose contents are not source and cannot meaningfully be rewritten. */
const BINARY_EXTENSIONS = new Set(['.png', '.ico', '.icns', '.woff', '.woff2', '.jpg', '.jpeg', '.gif', '.pdf']);

interface Rule {
  readonly name: string;
  readonly pattern: RegExp;
}

const RULES: readonly Rule[] = [
  { name: 'API key', pattern: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/ },
  { name: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/ },
  { name: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'private key block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'OAuth client secret', pattern: /["']?client_secret["']?\s*[:=]\s*["'][^"']{8,}["']/i },
  // A literal bearer value, as opposed to the `Bearer ${token}` interpolation the app uses.
  { name: 'hardcoded bearer', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/ },
  // Assignment of a credential-looking field to a literal, e.g. accessToken: "abc123..."
  {
    name: 'credential assigned a literal',
    pattern: /["']?(?:access|refresh|id)[_-]?token["']?\s*[:=]\s*["'][A-Za-z0-9._~+/-]{16,}["']/i,
  },
];

function trackedFiles(): string[] {
  const output = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  return output.split('\0').filter((entry) => entry !== '');
}

describe('no secrets in the repository', () => {
  const files = trackedFiles();

  it('has files to scan', () => {
    // A silently empty scan would pass forever and prove nothing.
    expect(files.length).toBeGreaterThan(20);
  });

  it('contains no credential-shaped literals', () => {
    const findings: string[] = [];

    for (const file of files) {
      if (BINARY_EXTENSIONS.has(extname(file).toLowerCase())) continue;
      // The scanner's own patterns would otherwise match themselves.
      if (file === 'test/no-secrets.test.ts') continue;

      let contents: string;
      try {
        contents = readFileSync(resolve(ROOT, file), 'utf8');
      } catch {
        continue;
      }

      contents.split('\n').forEach((line, index) => {
        for (const rule of RULES) {
          if (rule.pattern.test(line)) {
            findings.push(`${file}:${index + 1} — ${rule.name}`);
          }
        }
      });
    }

    expect(findings).toEqual([]);
  });

  it('never hardcodes an OAuth client id', () => {
    // The app drives the providers' own CLIs precisely so that no client identity of any
    // kind needs to exist here. A client_id appearing in source would mean that decision
    // had been quietly reversed.
    const offenders = files
      .filter((file) => file.startsWith('src/'))
      .filter((file) => /client[_-]?id/i.test(readFileSync(resolve(ROOT, file), 'utf8')));

    expect(offenders).toEqual([]);
  });
});
