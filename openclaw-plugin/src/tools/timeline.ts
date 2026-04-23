/**
 * gbrain_timeline — Temporal queries for a specific entity.
 */

import { Type } from '@sinclair/typebox';
import { getEngine } from '../engine-host.js';
import { textResult } from '../tool-result.js';

export const gbrainTimelineSchema = Type.Object({
  slug: Type.String({
    description: 'Page slug to get timeline for (e.g. "people/garry-tan", "companies/brex")',
  }),
  since: Type.Optional(
    Type.String({ description: 'Only entries after this date (ISO or "7d", "30d")' }),
  ),
  until: Type.Optional(
    Type.String({ description: 'Only entries before this date (ISO)' }),
  ),
  limit: Type.Optional(
    Type.Number({ default: 20, minimum: 1, maximum: 100, description: 'Max entries to return' }),
  ),
});

export async function executeTimeline(params: Record<string, unknown>) {
  const engine = getEngine();
  const slug = params['slug'] as string;
  const since = params['since'] as string | undefined;
  const until = params['until'] as string | undefined;
  const limit = (params['limit'] as number) ?? 20;

  const page = await engine.getPage(slug);
  if (!page) return textResult(`Page "${slug}" not found.`);

  const after = since ? resolveDate(since) : undefined;
  const before = until ? resolveDate(until) : undefined;

  const timeline = await engine.getTimeline(slug, { limit, after, before });

  if (timeline.length === 0) {
    return textResult(`No timeline entries found for "${page.title}".`);
  }

  const lines: string[] = [];
  lines.push(`## Timeline: ${page.title}`);
  lines.push(`${timeline.length} entries${after ? ` since ${after}` : ''}${before ? ` until ${before}` : ''}:\n`);

  for (const t of timeline) {
    lines.push(`**${t.date}** (${t.source}): ${t.summary}`);
    if (t.detail) lines.push(`  ${t.detail}`);
  }

  return textResult(lines.join('\n'), { entryCount: timeline.length });
}

function resolveDate(input: string): string {
  const relMatch = input.match(/^(\d+)d$/);
  if (relMatch) {
    const days = parseInt(relMatch[1], 10);
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString().split('T')[0];
  }
  return input;
}
