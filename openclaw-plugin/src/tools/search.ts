/**
 * gbrain_search — Hybrid search (keyword + semantic via RRF fusion).
 */

import { Type } from '@sinclair/typebox';
import { getEngine } from '../engine-host.js';
import { hybridSearch } from '../../../src/core/search/hybrid.ts';
import type { SearchOpts, PageType } from '../../../src/core/types.ts';
import { textResult, truncate } from '../tool-result.js';

const PAGE_TYPES = [
  'person', 'company', 'deal', 'meeting', 'project',
  'yc', 'civic', 'concept', 'source', 'media',
] as const;

export const gbrainSearchSchema = Type.Object({
  query: Type.String({ description: 'Natural language search query' }),
  scope: Type.Optional(
    Type.Union(
      PAGE_TYPES.map(t => Type.Literal(t)),
      { description: 'Limit search to a specific page type' },
    ),
  ),
  limit: Type.Optional(
    Type.Number({ default: 10, minimum: 1, maximum: 50, description: 'Max results to return' }),
  ),
  mode: Type.Optional(
    Type.Union(
      [Type.Literal('hybrid'), Type.Literal('keyword'), Type.Literal('semantic')],
      { default: 'hybrid', description: 'Search mode' },
    ),
  ),
});

export async function executeSearch(params: Record<string, unknown>) {
  const engine = getEngine();
  const query = params['query'] as string;
  const scope = params['scope'] as PageType | undefined;
  const limit = (params['limit'] as number) ?? 10;
  const mode = (params['mode'] as string) ?? 'hybrid';

  const opts: SearchOpts & { limit: number; type?: PageType } = { limit };
  if (scope) opts.type = scope;

  let results;
  if (mode === 'keyword') {
    results = await engine.searchKeyword(query, opts);
  } else {
    results = await hybridSearch(engine, query, opts);
  }

  if (results.length === 0) {
    return textResult(`No results found for "${query}".`);
  }

  const lines: string[] = [];
  lines.push(`Found ${results.length} result(s) for "${query}":\n`);

  for (const r of results) {
    lines.push(`## ${r.title}`);
    lines.push(`slug: ${r.slug} | type: ${r.type} | score: ${r.score.toFixed(3)}`);
    lines.push(truncate(r.chunk_text, 400));
    lines.push('');
  }

  return textResult(lines.join('\n'), { resultCount: results.length });
}
