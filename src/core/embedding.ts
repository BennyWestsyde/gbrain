/**
 * Embedding Service
 * Ported from production Ruby implementation (embedding_service.rb, 190 LOC)
 *
 * Default: OpenAI text-embedding-3-large at 1536 dimensions.
 * Fork override: set `embedding_model` + `embedding_dimensions` in
 * ~/.gbrain/config.json to route to any OpenAI-compatible embeddings
 * endpoint (e.g. local nomic via LM Studio). See
 * platform/memory/UPSTREAM_SYNC.md.
 *
 * Retry with exponential backoff (4s base, 120s cap, 5 retries).
 * 8000 character input truncation.
 */

import OpenAI from 'openai';
import { loadConfig } from './config.ts';

const DEFAULT_MODEL = 'text-embedding-3-large';
const DEFAULT_DIMENSIONS = 1536;
// Evaluated once at module load. Config is stable per-process; a swap
// requires restarting whichever CLI/daemon is running.
const _cfgModel = loadConfig()?.embedding_model;
const _cfgDim = loadConfig()?.embedding_dimensions;
const MODEL = _cfgModel ?? DEFAULT_MODEL;
const DIMENSIONS = _cfgDim ?? DEFAULT_DIMENSIONS;
// `dimensions` is OpenAI's matryoshka-truncation parameter, honoured by
// text-embedding-3-*. Local/OSS backends (nomic via LM Studio, bge-m3,
// etc.) either reject it or return malformed vectors. Only send it when
// we're on the upstream default.
const SEND_DIMENSIONS = _cfgModel === undefined;
const MAX_CHARS = 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 100;

let primaryClient: OpenAI | null = null;
let fallbackClient: OpenAI | null | undefined = undefined; // undefined = uninitialized, null = configured absent

function getPrimaryClient(): OpenAI {
  if (!primaryClient) {
    const cfg = loadConfig();
    const baseURL = process.env.GBRAIN_EMBEDDING_BASE_URL || cfg?.embedding_base_url;
    const apiKey = process.env.GBRAIN_EMBEDDING_API_KEY
      || (baseURL ? cfg?.embedding_api_key : undefined)
      || process.env.OPENAI_API_KEY
      || cfg?.openai_api_key;
    primaryClient = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  }
  return primaryClient;
}

// Returns null when no fallback is configured (either via env or config file).
function getFallbackClient(): OpenAI | null {
  if (fallbackClient !== undefined) return fallbackClient;
  const cfg = loadConfig();
  const baseURL = process.env.GBRAIN_EMBEDDING_FALLBACK_BASE_URL
    || cfg?.embedding_fallback_base_url;
  if (!baseURL) {
    fallbackClient = null;
    return null;
  }
  const apiKey = process.env.GBRAIN_EMBEDDING_FALLBACK_API_KEY
    || cfg?.embedding_fallback_api_key
    || process.env.OPENAI_API_KEY
    || cfg?.openai_api_key;
  fallbackClient = new OpenAI({ apiKey, baseURL });
  return fallbackClient;
}

export async function embed(text: string): Promise<Float32Array> {
  const truncated = text.slice(0, MAX_CHARS);
  const result = await embedBatch([truncated]);
  return result[0];
}

export interface EmbedBatchOptions {
  /**
   * Optional callback fired after each 100-item sub-batch completes.
   * CLI wrappers tick a reporter; Minion handlers can call
   * job.updateProgress here instead of hooking the per-page callback.
   */
  onBatchComplete?: (done: number, total: number) => void;
}

export async function embedBatch(
  texts: string[],
  options: EmbedBatchOptions = {},
): Promise<Float32Array[]> {
  const truncated = texts.map(t => t.slice(0, MAX_CHARS));
  const results: Float32Array[] = [];

  // Process in batches of BATCH_SIZE
  for (let i = 0; i < truncated.length; i += BATCH_SIZE) {
    const batch = truncated.slice(i, i + BATCH_SIZE);
    const batchResults = await embedBatchWithRetry(batch);
    results.push(...batchResults);
    options.onBatchComplete?.(results.length, truncated.length);
  }

  return results;
}

function buildRequest(texts: string[]) {
  const request: {
    model: string;
    input: string[];
    dimensions?: number;
    encoding_format?: 'float' | 'base64';
  } = { model: MODEL, input: texts };
  if (SEND_DIMENSIONS) request.dimensions = DIMENSIONS;
  // Force `float` for local/OSS backends. The OpenAI SDK defaults to
  // base64 (bandwidth win against OpenAI's servers), but LM Studio /
  // nomic return raw floats regardless — the SDK's base64 decoder
  // then produces garbage. Only override when using a non-default
  // model so upstream OpenAI behavior stays byte-identical.
  if (_cfgModel !== undefined) request.encoding_format = 'float';
  return request;
}

async function callEmbeddings(client: OpenAI, texts: string[]): Promise<Float32Array[]> {
  const response = await client.embeddings.create(buildRequest(texts));
  const sorted = response.data.sort((a, b) => a.index - b.index);
  return sorted.map(d => new Float32Array(d.embedding));
}

async function embedBatchWithRetry(texts: string[]): Promise<Float32Array[]> {
  let lastPrimaryError: unknown = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await callEmbeddings(getPrimaryClient(), texts);
    } catch (e: unknown) {
      lastPrimaryError = e;

      // Try the fallback endpoint immediately when configured. Kept
      // inside the retry loop so a flapping primary still gets another
      // shot on the next attempt — the fallback is a safety net, not a
      // permanent switch.
      const fb = getFallbackClient();
      if (fb) {
        try {
          const result = await callEmbeddings(fb, texts);
          console.warn(
            `[embedding] primary failed (${describeError(e)}), served from fallback`,
          );
          return result;
        } catch (fe) {
          console.warn(
            `[embedding] primary and fallback both failed (primary: ${describeError(e)}, fallback: ${describeError(fe)})`,
          );
        }
      }

      if (attempt === MAX_RETRIES - 1) throw lastPrimaryError;

      // Check for rate limit with Retry-After header
      let delay = exponentialDelay(attempt);

      if (e instanceof OpenAI.APIError && e.status === 429) {
        const retryAfter = e.headers?.['retry-after'];
        if (retryAfter) {
          const parsed = parseInt(retryAfter, 10);
          if (!isNaN(parsed)) {
            delay = parsed * 1000;
          }
        }
      }

      await sleep(delay);
    }
  }

  // Should not reach here
  throw new Error('Embedding failed after all retries');
}

function describeError(e: unknown): string {
  if (e instanceof OpenAI.APIError) return `${e.status} ${e.name}`;
  if (e instanceof Error) return e.message.slice(0, 120);
  return String(e).slice(0, 120);
}

function exponentialDelay(attempt: number): number {
  const delay = BASE_DELAY_MS * Math.pow(2, attempt);
  return Math.min(delay, MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export { MODEL as EMBEDDING_MODEL, DIMENSIONS as EMBEDDING_DIMENSIONS };

/**
 * v0.20.0 Cathedral II Layer 8 (D1): USD cost per 1k tokens for
 * text-embedding-3-large. Used by `gbrain sync --all` cost preview and
 * the reindex-code backfill command to surface expected spend before
 * the agent/user accepts an expensive operation.
 *
 * Value: $0.00013 / 1k tokens as of 2026. Update when OpenAI changes
 * pricing. Single source of truth — every cost-preview surface reads
 * this constant, so a pricing change is a one-line edit.
 */
export const EMBEDDING_COST_PER_1K_TOKENS = 0.00013;

/** Compute USD cost estimate for embedding `tokens` at current model rate. */
export function estimateEmbeddingCostUsd(tokens: number): number {
  return (tokens / 1000) * EMBEDDING_COST_PER_1K_TOKENS;
}
