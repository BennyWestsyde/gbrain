import { describe, test, expect, mock } from 'bun:test';

// The MODEL / DIMENSIONS constants are frozen at module-load time via
// loadConfig(). To exercise both the "config present" and "config absent"
// paths, each test isolates its own copy of the module by mocking
// ./config.ts before dynamic-importing ./embedding.ts.

describe('embedding module honours config overrides', () => {
  test('config sets embedding_model + embedding_dimensions → constants reflect it', async () => {
    mock.module('../src/core/config.ts', () => ({
      loadConfig: () => ({
        engine: 'postgres',
        embedding_model: 'text-embedding-nomic-embed-text-v1.5',
        embedding_dimensions: 768,
      }),
    }));
    // Cache-bust so the module re-evaluates against the fresh mock.
    // @ts-expect-error — Bun honours the query string at runtime; tsc doesn't.
    const mod = await import('../src/core/embedding.ts?config-present');
    expect(mod.EMBEDDING_MODEL).toBe('text-embedding-nomic-embed-text-v1.5');
    expect(mod.EMBEDDING_DIMENSIONS).toBe(768);
  });

  test('config absent → falls back to text-embedding-3-large @ 1536 (upstream default)', async () => {
    mock.module('../src/core/config.ts', () => ({
      loadConfig: () => null,
    }));
    // @ts-expect-error — see above.
    const mod = await import('../src/core/embedding.ts?config-null');
    expect(mod.EMBEDDING_MODEL).toBe('text-embedding-3-large');
    expect(mod.EMBEDDING_DIMENSIONS).toBe(1536);
  });

  test('config present but embedding fields omitted → falls back to defaults', async () => {
    mock.module('../src/core/config.ts', () => ({
      loadConfig: () => ({ engine: 'postgres' }),
    }));
    // @ts-expect-error — see above.
    const mod = await import('../src/core/embedding.ts?config-partial');
    expect(mod.EMBEDDING_MODEL).toBe('text-embedding-3-large');
    expect(mod.EMBEDDING_DIMENSIONS).toBe(1536);
  });
});
