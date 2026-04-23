/**
 * gbrain_resolve — Entity resolution (name → page).
 */

import { Type } from '@sinclair/typebox';
import { getEngine } from '../engine-host.js';
import type { PageType } from '../../../src/core/types.ts';
import { textResult, truncate } from '../tool-result.js';

export const gbrainResolveSchema = Type.Object({
  name: Type.String({
    description: 'Entity name to resolve (e.g. "Pedro", "Brex", "the Variant deal")',
  }),
  type: Type.Optional(
    Type.Union(
      [
        Type.Literal('person'),
        Type.Literal('company'),
        Type.Literal('deal'),
        Type.Literal('meeting'),
        Type.Literal('any'),
      ],
      { default: 'any', description: 'Expected entity type' },
    ),
  ),
});

export async function executeResolve(params: Record<string, unknown>) {
  const engine = getEngine();
  const name = params['name'] as string;
  const type = (params['type'] as string) ?? 'any';

  // 1. Try direct slug resolution
  const slugCandidates = await engine.resolveSlugs(name.toLowerCase().replace(/\s+/g, '-'));

  const filtered = type !== 'any'
    ? await filterByType(engine, slugCandidates, type as PageType)
    : slugCandidates;

  if (filtered.length > 0) {
    const bestSlug = filtered[0];
    const page = await engine.getPage(bestSlug);
    if (page) {
      return textResult(
        `Resolved: **${page.title}**\n` +
        `slug: ${page.slug} | type: ${page.type}\n\n` +
        truncate(page.compiled_truth, 500),
        { slug: page.slug, type: page.type, confidence: 1.0 },
      );
    }
  }

  // 2. Fall back to keyword search
  const searchOpts = type !== 'any' ? { type: type as PageType, limit: 5 } : { limit: 5 };
  const searchResults = await engine.searchKeyword(name, searchOpts);

  if (searchResults.length > 0) {
    const best = searchResults[0];
    const page = await engine.getPage(best.slug);
    if (page && best.score > 0.3) {
      const others = searchResults.slice(1).map(r =>
        `  - ${r.title} (${r.slug}, score: ${r.score.toFixed(2)})`,
      );
      return textResult(
        `Best match: **${page.title}** (score: ${best.score.toFixed(2)})\n` +
        `slug: ${page.slug} | type: ${page.type}\n\n` +
        truncate(page.compiled_truth, 400) +
        (others.length > 0 ? `\n\nOther candidates:\n${others.join('\n')}` : ''),
        { slug: page.slug, type: page.type, confidence: best.score },
      );
    }
  }

  return textResult(`No confident match found for "${name}".`);
}

async function filterByType(
  engine: ReturnType<typeof getEngine>,
  slugs: string[],
  type: PageType,
): Promise<string[]> {
  const result: string[] = [];
  for (const slug of slugs) {
    const page = await engine.getPage(slug);
    if (page && page.type === type) result.push(slug);
  }
  return result;
}
