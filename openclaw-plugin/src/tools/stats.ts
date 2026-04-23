/**
 * gbrain_stats — Brain health and statistics.
 */

import { Type } from '@sinclair/typebox';
import { getEngine } from '../engine-host.js';
import { textResult } from '../tool-result.js';

export const gbrainStatsSchema = Type.Object({});

export async function executeStats() {
  const engine = getEngine();

  const [stats, health] = await Promise.all([
    engine.getStats(),
    engine.getHealth(),
  ]);

  const lines: string[] = [];
  lines.push('## GBrain Stats\n');
  lines.push(`**Pages:** ${stats.page_count}`);
  lines.push(`**Chunks:** ${stats.chunk_count} (${stats.embedded_count} embedded)`);
  lines.push(`**Links:** ${stats.link_count}`);
  lines.push(`**Timeline entries:** ${stats.timeline_entry_count}`);
  lines.push(`**Tags:** ${stats.tag_count}`);

  lines.push('\n### Pages by Type\n');
  for (const [type, count] of Object.entries(stats.pages_by_type).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${type}: ${count}`);
  }

  lines.push('\n### Health\n');
  lines.push(`**Brain Score:** ${health.brain_score}/100`);
  lines.push(`**Embed Coverage:** ${(health.embed_coverage * 100).toFixed(1)}%`);
  lines.push(`**Link Coverage:** ${(health.link_coverage * 100).toFixed(1)}%`);
  lines.push(`**Timeline Coverage:** ${(health.timeline_coverage * 100).toFixed(1)}%`);
  lines.push(`**Stale Pages:** ${health.stale_pages}`);
  lines.push(`**Orphan Pages:** ${health.orphan_pages}`);
  lines.push(`**Dead Links:** ${health.dead_links}`);

  if (health.most_connected.length > 0) {
    lines.push('\n### Most Connected\n');
    for (const mc of health.most_connected) {
      lines.push(`- ${mc.slug}: ${mc.link_count} links`);
    }
  }

  return textResult(lines.join('\n'), {
    pageCount: stats.page_count,
    brainScore: health.brain_score,
  });
}
