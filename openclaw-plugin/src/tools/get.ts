/**
 * gbrain_get — Direct page read by slug.
 */

import { Type } from '@sinclair/typebox';
import { getEngine } from '../engine-host.js';
import { textResult } from '../tool-result.js';

export const gbrainGetSchema = Type.Object({
  slug: Type.String({ description: 'Page slug (e.g. "people/garry-tan", "companies/brex")' }),
  includeTimeline: Type.Optional(
    Type.Boolean({ default: false, description: 'Include timeline entries' }),
  ),
  includeLinks: Type.Optional(
    Type.Boolean({ default: false, description: 'Include links and backlinks' }),
  ),
});

export async function executeGet(params: Record<string, unknown>) {
  const engine = getEngine();
  const slug = params['slug'] as string;
  const includeTimeline = params['includeTimeline'] as boolean ?? false;
  const includeLinks = params['includeLinks'] as boolean ?? false;

  const page = await engine.getPage(slug);
  if (!page) {
    const candidates = await engine.resolveSlugs(slug);
    if (candidates.length > 0) {
      return textResult(
        `Page "${slug}" not found. Did you mean:\n` +
        candidates.slice(0, 5).map(c => `  - ${c}`).join('\n'),
      );
    }
    return textResult(`Page "${slug}" not found.`);
  }

  const lines: string[] = [];
  lines.push(`# ${page.title}`);
  lines.push(`slug: ${page.slug} | type: ${page.type} | updated: ${page.updated_at.toISOString()}`);
  lines.push('');
  lines.push(page.compiled_truth);

  if (includeTimeline) {
    const timeline = await engine.getTimeline(slug);
    if (timeline.length > 0) {
      lines.push('\n---\n## Timeline\n');
      for (const t of timeline) {
        lines.push(`**${t.date}** (${t.source}): ${t.summary}`);
        if (t.detail) lines.push(`  ${t.detail}`);
      }
    }
  }

  if (includeLinks) {
    const [links, backlinks] = await Promise.all([
      engine.getLinks(slug),
      engine.getBacklinks(slug),
    ]);
    if (links.length > 0) {
      lines.push('\n## Links (outgoing)\n');
      for (const l of links) {
        lines.push(`- → ${l.to_slug} [${l.link_type}]${l.context ? ` — ${l.context}` : ''}`);
      }
    }
    if (backlinks.length > 0) {
      lines.push('\n## Backlinks (incoming)\n');
      for (const l of backlinks) {
        lines.push(`- ← ${l.from_slug} [${l.link_type}]${l.context ? ` — ${l.context}` : ''}`);
      }
    }
  }

  return textResult(lines.join('\n'), { slug: page.slug, type: page.type });
}
