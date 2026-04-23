/**
 * gbrain_graph — Relationship traversal.
 */

import { Type } from '@sinclair/typebox';
import { getEngine } from '../engine-host.js';
import { textResult } from '../tool-result.js';

export const gbrainGraphSchema = Type.Object({
  entity: Type.String({
    description: 'Entity slug or name to start from (e.g. "people/garry-tan", "Brex")',
  }),
  direction: Type.Optional(
    Type.Union(
      [Type.Literal('outgoing'), Type.Literal('incoming'), Type.Literal('both')],
      { default: 'both', description: 'Edge direction to traverse' },
    ),
  ),
  depth: Type.Optional(
    Type.Number({ default: 1, minimum: 1, maximum: 3, description: 'Traversal depth (1-3)' }),
  ),
});

export async function executeGraph(params: Record<string, unknown>) {
  const engine = getEngine();
  const entity = params['entity'] as string;
  const direction = (params['direction'] as string) ?? 'both';
  const depth = (params['depth'] as number) ?? 1;

  // Resolve entity to slug
  let slug = entity;
  let rootPage = await engine.getPage(slug);
  if (!rootPage) {
    const candidates = await engine.resolveSlugs(slug.toLowerCase().replace(/\s+/g, '-'));
    if (candidates.length > 0) {
      slug = candidates[0];
      rootPage = await engine.getPage(slug);
    }
    if (!rootPage) {
      const search = await engine.searchKeyword(entity, { limit: 1 });
      if (search.length > 0) {
        slug = search[0].slug;
        rootPage = await engine.getPage(slug);
      }
    }
  }

  if (!rootPage) return textResult(`No entity found matching "${entity}".`);

  const lines: string[] = [];
  lines.push(`## ${rootPage.title} (${rootPage.type})`);
  lines.push(`slug: ${rootPage.slug}\n`);

  const visited = new Set<string>([slug]);
  const edges: Array<{ from: string; to: string; type: string; context: string; depth: number }> = [];

  await traverse(engine, slug, direction, depth, 1, visited, edges);

  if (edges.length === 0) {
    lines.push('No connected entities found.');
  } else {
    lines.push(`Found ${edges.length} connection(s):\n`);
    for (const e of edges) {
      const arrow = e.from === slug ? '→' : '←';
      const other = e.from === slug ? e.to : e.from;
      lines.push(`- ${arrow} **${other}** [${e.type}]${e.context ? ` — ${e.context}` : ''} (depth ${e.depth})`);
    }
  }

  return textResult(lines.join('\n'), { edgeCount: edges.length });
}

async function traverse(
  engine: ReturnType<typeof getEngine>,
  slug: string,
  direction: string,
  maxDepth: number,
  currentDepth: number,
  visited: Set<string>,
  edges: Array<{ from: string; to: string; type: string; context: string; depth: number }>,
) {
  if (currentDepth > maxDepth) return;

  const [outgoing, incoming] = await Promise.all([
    (direction === 'outgoing' || direction === 'both') ? engine.getLinks(slug) : Promise.resolve([]),
    (direction === 'incoming' || direction === 'both') ? engine.getBacklinks(slug) : Promise.resolve([]),
  ]);

  const nextSlugs: string[] = [];

  for (const link of outgoing) {
    edges.push({ from: link.from_slug, to: link.to_slug, type: link.link_type, context: link.context, depth: currentDepth });
    if (!visited.has(link.to_slug)) {
      visited.add(link.to_slug);
      nextSlugs.push(link.to_slug);
    }
  }

  for (const link of incoming) {
    edges.push({ from: link.from_slug, to: link.to_slug, type: link.link_type, context: link.context, depth: currentDepth });
    if (!visited.has(link.from_slug)) {
      visited.add(link.from_slug);
      nextSlugs.push(link.from_slug);
    }
  }

  for (const next of nextSlugs) {
    await traverse(engine, next, direction, maxDepth, currentDepth + 1, visited, edges);
  }
}
