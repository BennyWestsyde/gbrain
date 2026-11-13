/**
 * A process whose gateway loaded another embedding model than the config names
 * now (a `gbrain serve` started before `gbrain migrate embeddings`) must not
 * embed queries: its vector arm would match no chunk. Search goes keyword-only
 * and says why.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { staleEmbeddingModel } from '../../src/core/search/stale-embedding-model.ts';
import type { HybridSearchMeta } from '../../src/core/types.ts';
import { withEnv } from '../helpers/with-env.ts';

describe('staleEmbeddingModel', () => {
  test('names both models when they differ', () => {
    expect(staleEmbeddingModel({ loaded: () => 'lmstudio:old-embed', configured: () => 'lmstudio:new-embed' }))
      .toEqual({ loaded: 'lmstudio:old-embed', configured: 'lmstudio:new-embed' });
  });

  test('null when they match, ignoring surrounding space', () => {
    expect(staleEmbeddingModel({ loaded: () => 'lmstudio:new-embed', configured: () => ' lmstudio:new-embed ' })).toBeNull();
  });

  test('null without a configured or a loaded model', () => {
    expect(staleEmbeddingModel({ loaded: () => 'lmstudio:new-embed', configured: () => undefined })).toBeNull();
    expect(staleEmbeddingModel({ loaded: () => null, configured: () => 'lmstudio:new-embed' })).toBeNull();
  });

  test('null when a read throws', () => {
    expect(staleEmbeddingModel({ loaded: () => { throw new Error('gateway unconfigured'); }, configured: () => 'x:y' })).toBeNull();
  });

  test('reads the config file on disk', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-stale-embed-'));
    try {
      mkdirSync(join(home, '.gbrain'));
      writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536 }));
      await withEnv({ GBRAIN_HOME: home, GBRAIN_EMBEDDING_MODEL: undefined }, async () => {
        expect(staleEmbeddingModel({ loaded: () => 'openai:text-embedding-3-large' }))
          .toEqual({ loaded: 'openai:text-embedding-3-large', configured: 'openai:text-embedding-3-small' });
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('hybridSearch with a stale embedding model', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.putPage('notes/alpha-example', { type: 'note', title: 'Alpha example', compiled_truth: 'alpha example renewal notes' });
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  afterEach(() => resetGateway());

  test('skips the query embed and reports embedding_model_stale', async () => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { OPENAI_API_KEY: 'sk-fake' },
    });
    let meta: HybridSearchMeta | null = null;
    await hybridSearch(engine, 'alpha example', {
      _embeddingStale: { loaded: 'openai:text-embedding-3-large', configured: 'openai:text-embedding-3-small' },
      onMeta: m => { meta = m; },
    });
    expect(meta!.vector_enabled).toBe(false);
    expect(meta!.degraded).toContainEqual({ stage: 'embed_unavailable', reason: 'embedding_model_stale' });
  });
});
