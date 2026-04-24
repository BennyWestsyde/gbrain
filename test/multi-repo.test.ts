import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Isolate ~/.gbrain/ per test by overriding GBRAIN_HOME before importing the module.
// Bun's os.homedir() ignores HOME env var on macOS, so we need the explicit override.
let TMPHOME: string;
let REPO_A: string;
let REPO_B: string;

beforeEach(() => {
  TMPHOME = mkdtempSync(join(tmpdir(), 'gbrain-multirepo-'));
  process.env.GBRAIN_HOME = TMPHOME;
  REPO_A = mkdtempSync(join(tmpdir(), 'repo-a-'));
  REPO_B = mkdtempSync(join(tmpdir(), 'repo-b-'));
});

afterEach(() => {
  delete process.env.GBRAIN_HOME;
  rmSync(TMPHOME, { recursive: true, force: true });
  rmSync(REPO_A, { recursive: true, force: true });
  rmSync(REPO_B, { recursive: true, force: true });
});

describe('normalizeRepoName', () => {
  test('extracts last path segment', async () => {
    const { normalizeRepoName } = await import('../src/core/multi-repo.ts');
    expect(normalizeRepoName('/Users/garry/gbrain')).toBe('gbrain');
    expect(normalizeRepoName('/Users/garry/gbrain/')).toBe('gbrain');
    expect(normalizeRepoName('/tmp/a/b/c/project-x')).toBe('project-x');
  });

  test('handles root path fallback', async () => {
    const { normalizeRepoName } = await import('../src/core/multi-repo.ts');
    expect(normalizeRepoName('/')).toBe('repo');
  });
});

describe('loadRepoConfigs', () => {
  test('returns empty array when config does not exist', async () => {
    const { loadRepoConfigs } = await import('../src/core/multi-repo.ts');
    expect(loadRepoConfigs()).toEqual([]);
  });

  test('returns empty array when config has no repos key', async () => {
    mkdirSync(join(TMPHOME, '.gbrain'), { recursive: true });
    writeFileSync(join(TMPHOME, '.gbrain', 'config.json'), '{"engine":"pglite"}');
    const { loadRepoConfigs } = await import('../src/core/multi-repo.ts');
    expect(loadRepoConfigs()).toEqual([]);
  });

  test('skips malformed repo entries', async () => {
    mkdirSync(join(TMPHOME, '.gbrain'), { recursive: true });
    writeFileSync(
      join(TMPHOME, '.gbrain', 'config.json'),
      JSON.stringify({
        repos: [
          { path: REPO_A, name: 'a', strategy: 'markdown' },
          null,
          { path: 123, name: 'bad-path' },
          { name: 'no-path' },
          'not-an-object',
        ],
      }),
    );
    const { loadRepoConfigs } = await import('../src/core/multi-repo.ts');
    const repos = loadRepoConfigs();
    expect(repos.length).toBe(1);
    expect(repos[0]!.name).toBe('a');
  });

  test('defaults strategy to markdown on invalid strategy string', async () => {
    mkdirSync(join(TMPHOME, '.gbrain'), { recursive: true });
    writeFileSync(
      join(TMPHOME, '.gbrain', 'config.json'),
      JSON.stringify({
        repos: [{ path: REPO_A, name: 'a', strategy: 'bogus-value' }],
      }),
    );
    const { loadRepoConfigs } = await import('../src/core/multi-repo.ts');
    expect(loadRepoConfigs()[0]!.strategy).toBe('markdown');
  });
});

describe('addRepoConfig', () => {
  test('persists a new repo and returns the full list', async () => {
    const { addRepoConfig, loadRepoConfigs } = await import('../src/core/multi-repo.ts');
    const result = addRepoConfig({ path: REPO_A, name: 'repo-a', strategy: 'code' });
    expect(result.length).toBe(1);
    expect(result[0]!.name).toBe('repo-a');
    expect(result[0]!.strategy).toBe('code');
    // Persisted
    const reloaded = loadRepoConfigs();
    expect(reloaded.length).toBe(1);
    expect(reloaded[0]!.name).toBe('repo-a');
  });

  test('rejects duplicate name', async () => {
    const { addRepoConfig } = await import('../src/core/multi-repo.ts');
    addRepoConfig({ path: REPO_A, name: 'same', strategy: 'markdown' });
    expect(() =>
      addRepoConfig({ path: REPO_B, name: 'same', strategy: 'markdown' }),
    ).toThrow(/name already exists/i);
  });

  test('rejects duplicate path', async () => {
    const { addRepoConfig } = await import('../src/core/multi-repo.ts');
    addRepoConfig({ path: REPO_A, name: 'a-one', strategy: 'markdown' });
    expect(() =>
      addRepoConfig({ path: REPO_A, name: 'a-two', strategy: 'markdown' }),
    ).toThrow(/path already configured/i);
  });

  test('writes config file with 0o600 permissions', async () => {
    const { addRepoConfig } = await import('../src/core/multi-repo.ts');
    addRepoConfig({ path: REPO_A, name: 'secret', strategy: 'markdown' });
    const mode = statSync(join(TMPHOME, '.gbrain', 'config.json')).mode & 0o777;
    // 0o600 on macOS/Linux; Windows may not honor chmod but we don't block on it
    if (process.platform !== 'win32') {
      expect(mode).toBe(0o600);
    }
  });
});

describe('removeRepoConfig', () => {
  test('removes an existing repo and returns remaining list', async () => {
    const { addRepoConfig, removeRepoConfig } = await import('../src/core/multi-repo.ts');
    addRepoConfig({ path: REPO_A, name: 'a', strategy: 'markdown' });
    addRepoConfig({ path: REPO_B, name: 'b', strategy: 'code' });
    const remaining = removeRepoConfig('a');
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.name).toBe('b');
  });

  test('throws on unknown repo name', async () => {
    const { removeRepoConfig } = await import('../src/core/multi-repo.ts');
    expect(() => removeRepoConfig('does-not-exist')).toThrow(/not found/i);
  });
});

describe('saveRepoConfigs round-trip', () => {
  test('round-trips include/exclude globs and syncEnabled=false', async () => {
    const { saveRepoConfigs, loadRepoConfigs } = await import('../src/core/multi-repo.ts');
    saveRepoConfigs([
      {
        path: REPO_A,
        name: 'a',
        strategy: 'auto',
        include: ['src/**/*.ts'],
        exclude: ['node_modules/**'],
        syncEnabled: false,
      },
    ]);
    const [loaded] = loadRepoConfigs();
    expect(loaded!.include).toEqual(['src/**/*.ts']);
    expect(loaded!.exclude).toEqual(['node_modules/**']);
    expect(loaded!.syncEnabled).toBe(false);
  });

  test('omits empty include/exclude arrays from disk', async () => {
    const { saveRepoConfigs } = await import('../src/core/multi-repo.ts');
    saveRepoConfigs([
      { path: REPO_A, name: 'a', strategy: 'markdown', include: [], exclude: [] },
    ]);
    const raw = JSON.parse(readFileSync(join(TMPHOME, '.gbrain', 'config.json'), 'utf-8'));
    expect('include' in raw.repos[0]).toBe(false);
    expect('exclude' in raw.repos[0]).toBe(false);
  });
});
