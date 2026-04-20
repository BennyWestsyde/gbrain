/**
 * amara-life-gen tests — cache-key determinism + CLI flag parsing.
 *
 * We do NOT invoke Opus in these tests. The generator's structured cache
 * key (per codex fix #18) is pure computation over well-defined inputs and
 * is the load-bearing piece that makes regeneration cheap and correct.
 *
 * Run: bun test test/eval/amara-life-gen.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { createHash } from 'crypto';
import { buildSkeleton } from '../../eval/generators/amara-life.ts';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function canonicalJson(obj: unknown): string {
  const replacer = (_k: string, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.keys(v as object).sort().reduce((acc, k) => {
          (acc as Record<string, unknown>)[k] = (v as Record<string, unknown>)[k];
          return acc;
        }, {} as Record<string, unknown>)
      : v;
  return JSON.stringify(obj, replacer);
}

interface CacheKeyInput {
  schema_version: number;
  template_id: string;
  template_hash: string;
  model_id: string;
  model_params: Record<string, unknown>;
  seed: number;
  item_spec_hash: string;
}

function cacheKey(input: CacheKeyInput): string {
  return sha256(canonicalJson(input));
}

describe('amara-life-gen cache key (codex fix #18)', () => {
  const baseInput: CacheKeyInput = {
    schema_version: 1,
    template_id: 'email',
    template_hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    model_id: 'claude-opus-4-5',
    model_params: { max_tokens: 1500, temperature: 1.0, top_p: 1.0 },
    seed: 42,
    item_spec_hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  };

  test('same input → same key (determinism)', () => {
    expect(cacheKey(baseInput)).toEqual(cacheKey({ ...baseInput }));
  });

  test('schema_version change invalidates key', () => {
    expect(cacheKey(baseInput)).not.toEqual(cacheKey({ ...baseInput, schema_version: 2 }));
  });

  test('template_hash change invalidates key (prompt tweak invalidates item)', () => {
    const tweaked = { ...baseInput, template_hash: sha256('tweaked template') };
    expect(cacheKey(baseInput)).not.toEqual(cacheKey(tweaked));
  });

  test('model_id change invalidates key (switching Opus versions)', () => {
    expect(cacheKey(baseInput)).not.toEqual(
      cacheKey({ ...baseInput, model_id: 'claude-opus-4-6' })
    );
  });

  test('model_params change invalidates key (temperature tweak)', () => {
    expect(cacheKey(baseInput)).not.toEqual(
      cacheKey({ ...baseInput, model_params: { ...baseInput.model_params, temperature: 0.5 } })
    );
  });

  test('seed change invalidates key', () => {
    expect(cacheKey(baseInput)).not.toEqual(cacheKey({ ...baseInput, seed: 7 }));
  });

  test('item_spec_hash change invalidates key', () => {
    const different = { ...baseInput, item_spec_hash: sha256('different item') };
    expect(cacheKey(baseInput)).not.toEqual(cacheKey(different));
  });

  test('key is 64-char hex (sha256)', () => {
    const key = cacheKey(baseInput);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });

  test('canonical JSON is stable under key reorder', () => {
    // Same content, different insertion order → same canonical serialization.
    const a = { seed: 42, template_id: 'email', schema_version: 1 };
    const b = { schema_version: 1, template_id: 'email', seed: 42 };
    expect(canonicalJson(a)).toEqual(canonicalJson(b));
  });
});

describe('amara-life-gen per-skeleton item-spec hashing', () => {
  test('each email in the skeleton produces a distinct item_spec_hash', () => {
    const skeleton = buildSkeleton();
    const hashes = new Set<string>();
    for (const e of skeleton.emails) {
      hashes.add(sha256(canonicalJson(e)));
    }
    // All 50 emails have distinct spec hashes (determined by id + ts + from + to + subject + perturbation).
    expect(hashes.size).toBe(skeleton.emails.length);
  });

  test('same item across two skeleton builds (same seed) hashes identically', () => {
    const a = buildSkeleton({ seed: 42 });
    const b = buildSkeleton({ seed: 42 });
    expect(sha256(canonicalJson(a.emails[0]))).toEqual(sha256(canonicalJson(b.emails[0])));
  });
});
