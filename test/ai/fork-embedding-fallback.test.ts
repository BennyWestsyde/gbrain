/**
 * Fork: embedding fallback endpoint (cfg.embedding_fallback). A failed
 * primary sub-batch is retried once on the fallback; the primary's key never
 * reaches the fallback host; config-class errors are not retried.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { configureGateway, embed, resetGateway } from '../../src/core/ai/gateway.ts';
import { buildGatewayConfig } from '../../src/core/ai/build-gateway-config.ts';

type Seen = { auth: string | null; calls: number };

function fakeEmbeddingServer(opts: { status?: number; dims: number }) {
  const seen: Seen = { auth: null, calls: 0 };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      seen.calls++;
      seen.auth = req.headers.get('authorization');
      if (opts.status && opts.status !== 200) return new Response('boom', { status: opts.status });
      const body = (await req.json()) as { input: string[] };
      return Response.json({
        object: 'list',
        data: body.input.map((_, index) => ({ object: 'embedding', index, embedding: Array(opts.dims).fill(0.5) })),
        model: 'm',
        usage: { prompt_tokens: 1, total_tokens: 1 },
      });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, seen, stop: () => server.stop(true) };
}

const servers: Array<{ stop: () => void }> = [];
afterEach(() => { for (const s of servers.splice(0)) s.stop(); });
beforeEach(() => resetGateway());
afterAll(() => resetGateway());

function configure(primaryUrl: string, fallback?: { base_url: string; api_key?: string }, dims = 8) {
  configureGateway({
    embedding_model: 'lmstudio:nomic-test',
    embedding_dimensions: dims,
    base_urls: { lmstudio: primaryUrl },
    env: { LMSTUDIO_API_KEY: 'primary-secret' },
    ...(fallback ? { embedding_fallback: fallback } : {}),
  });
}

describe('embedding fallback', () => {
  test('a failing primary is retried on the fallback', async () => {
    const primary = fakeEmbeddingServer({ status: 500, dims: 8 });
    const fallback = fakeEmbeddingServer({ dims: 8 });
    servers.push(primary, fallback);
    configure(primary.url, { base_url: fallback.url });

    const out = await embed(['a', 'b'], { maxRetries: 0 });

    expect(out).toHaveLength(2);
    expect(out[0]).toHaveLength(8);
    expect(primary.seen.calls).toBeGreaterThan(0);
    expect(fallback.seen.calls).toBe(1);
  });

  test("the primary's key is not sent to the fallback", async () => {
    const primary = fakeEmbeddingServer({ status: 503, dims: 8 });
    const fallback = fakeEmbeddingServer({ dims: 8 });
    servers.push(primary, fallback);

    configure(primary.url, { base_url: fallback.url });
    await embed(['a'], { maxRetries: 0 });
    expect(primary.seen.auth).toBe('Bearer primary-secret');
    expect(fallback.seen.auth).toBe('Bearer unauthenticated');

    resetGateway();
    configure(primary.url, { base_url: fallback.url, api_key: 'fallback-key' });
    await embed(['a'], { maxRetries: 0 });
    expect(fallback.seen.auth).toBe('Bearer fallback-key');
  });

  test('no fallback configured: the primary error surfaces', async () => {
    const primary = fakeEmbeddingServer({ status: 500, dims: 8 });
    servers.push(primary);
    configure(primary.url);
    await expect(embed(['a'], { maxRetries: 0 })).rejects.toThrow();
  });

  test('a healthy primary never touches the fallback', async () => {
    const primary = fakeEmbeddingServer({ dims: 8 });
    const fallback = fakeEmbeddingServer({ dims: 8 });
    servers.push(primary, fallback);
    configure(primary.url, { base_url: fallback.url });
    await embed(['a'], { maxRetries: 0 });
    expect(fallback.seen.calls).toBe(0);
  });

  test('a fallback serving the wrong dimensions is rejected, not stored', async () => {
    const primary = fakeEmbeddingServer({ status: 500, dims: 8 });
    const fallback = fakeEmbeddingServer({ dims: 4 });
    servers.push(primary, fallback);
    configure(primary.url, { base_url: fallback.url });
    await expect(embed(['a'], { maxRetries: 0 })).rejects.toThrow(/dim/i);
  });

  test('buildGatewayConfig reads the fork config keys', () => {
    const cfg = buildGatewayConfig({
      engine: 'postgres',
      embedding_fallback_base_url: 'http://localhost:1234/v1',
      embedding_fallback_api_key: 'k',
    } as any);
    expect(cfg.embedding_fallback).toEqual({ base_url: 'http://localhost:1234/v1', api_key: 'k' });
    expect(buildGatewayConfig({ engine: 'postgres' } as any).embedding_fallback).toBeUndefined();
  });
});
