/**
 * gbrain_ingest — Create or update brain pages with automatic re-indexing.
 */

import { Type } from '@sinclair/typebox';
import { getEngine, getConfig } from '../engine-host.js';
import { parseMarkdown, serializeMarkdown } from '../../../src/core/markdown.ts';
import type { PageType } from '../../../src/core/types.ts';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { textResult } from '../tool-result.js';

export const gbrainIngestSchema = Type.Object({
  slug: Type.String({
    description: 'Brain-relative slug (e.g. "people/new-person", "companies/acme")',
  }),
  content: Type.Optional(
    Type.String({ description: 'Full page markdown content (for new pages)' }),
  ),
  timelineEntry: Type.Optional(
    Type.String({ description: 'Text to prepend as a new timeline entry (date auto-added)' }),
  ),
  compiledTruthUpdate: Type.Optional(
    Type.String({ description: 'New compiled truth body (replaces compiled truth section)' }),
  ),
});

export async function executeIngest(params: Record<string, unknown>) {
  const engine = getEngine();
  const config = getConfig();
  const slug = params['slug'] as string;
  const content = params['content'] as string | undefined;
  const timelineEntry = params['timelineEntry'] as string | undefined;
  const compiledTruthUpdate = params['compiledTruthUpdate'] as string | undefined;

  const filePath = join(config.brainPath, `${slug}.md`);
  const actions: string[] = [];

  if (content) {
    // New page — write full content
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, content, 'utf-8');
    actions.push('created');

    // Index the new page
    const parsed = parseMarkdown(content, filePath);
    await engine.putPage(slug, {
      type: parsed.type,
      title: parsed.title,
      compiled_truth: parsed.compiled_truth,
      timeline: parsed.timeline,
      frontmatter: parsed.frontmatter,
    });
    actions.push('indexed');
  } else if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf-8');
    const parsed = parseMarkdown(existing, filePath);
    let newCompiledTruth = parsed.compiled_truth;
    let newTimeline = parsed.timeline;

    if (compiledTruthUpdate) {
      newCompiledTruth = compiledTruthUpdate;
      actions.push('compiled_truth_updated');
    }

    if (timelineEntry) {
      const today = new Date().toISOString().split('T')[0];
      const entry = `- **${today}**: ${timelineEntry}`;
      newTimeline = entry + '\n' + newTimeline;
      actions.push('timeline_prepended');
    }

    if (actions.length > 0) {
      const serialized = serializeMarkdown(
        parsed.frontmatter,
        newCompiledTruth,
        newTimeline,
        { type: parsed.type, title: parsed.title, tags: parsed.tags },
      );
      writeFileSync(filePath, serialized, 'utf-8');

      // Re-index
      await engine.putPage(slug, {
        type: parsed.type,
        title: parsed.title,
        compiled_truth: newCompiledTruth,
        timeline: newTimeline,
        frontmatter: parsed.frontmatter,
      });
      actions.push('re-indexed');
    }
  } else {
    return textResult(`Page "${slug}" not found and no content provided for creation.`);
  }

  return textResult(`Done: ${actions.join(', ')} for ${slug}`, { actions, slug });
}
