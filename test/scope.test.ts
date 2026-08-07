import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountScope, PathEscapeError, expandHome } from '@main/scope';
import { homedir } from 'node:os';

describe('AccountScope', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'scope-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads files inside its root', async () => {
    await writeFile(join(root, 'creds.json'), '{"a":1}', 'utf8');
    const scope = new AccountScope(root);
    expect(await scope.readText('creds.json')).toBe('{"a":1}');
  });

  it('refuses to read outside its root, which is what keeps accounts separate', async () => {
    const scope = new AccountScope(root);
    expect(() => scope.resolveWithin('../secrets.json')).toThrow(PathEscapeError);
    await expect(scope.readText('../../etc/passwd')).rejects.toThrow(PathEscapeError);
  });

  it('allows only the companion files declared up front', async () => {
    const sibling = join(root, '..', `companion-${process.pid}.json`);
    await writeFile(sibling, '{"ok":true}', 'utf8');
    try {
      const permitted = new AccountScope(root, [sibling]);
      expect(await permitted.readText(sibling)).toBe('{"ok":true}');

      const notPermitted = new AccountScope(root);
      await expect(notPermitted.readText(sibling)).rejects.toThrow(PathEscapeError);
    } finally {
      await rm(sibling, { force: true });
    }
  });

  it('reports a missing file as undefined but malformed JSON as a distinct failure', async () => {
    const scope = new AccountScope(root);
    expect(await scope.readJson('absent.json')).toBeUndefined();

    await writeFile(join(root, 'broken.json'), '{ nope', 'utf8');
    const result = await scope.readJson('broken.json');
    expect(result?.ok).toBe(false);
  });

  it('reads only the tail of a large file', async () => {
    const body = `${'x'.repeat(5_000)}TAIL`;
    await writeFile(join(root, 'big.log'), body, 'utf8');
    const scope = new AccountScope(root);
    const tail = await scope.readTailText(join(root, 'big.log'), 10);
    expect(tail).toBe('xxxxxxTAIL');
  });

  it('lists files recursively and tolerates a missing directory', async () => {
    await mkdir(join(root, 'sessions', '2026', '08'), { recursive: true });
    await writeFile(join(root, 'sessions', '2026', '08', 'rollout-a.jsonl'), '', 'utf8');
    await writeFile(join(root, 'sessions', '2026', '08', 'notes.txt'), '', 'utf8');

    const scope = new AccountScope(root);
    const found = await scope.listFiles('sessions', { extension: '.jsonl' });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('rollout-a.jsonl');

    expect(await scope.listFiles('nonexistent')).toEqual([]);
  });
});

describe('expandHome', () => {
  it('expands a leading tilde', () => {
    expect(expandHome('~/.claude')).toBe(join(homedir(), '.claude'));
    expect(expandHome('~')).toBe(homedir());
  });

  it('leaves an absolute path alone', () => {
    expect(expandHome('/opt/thing')).toBe('/opt/thing');
  });
});
