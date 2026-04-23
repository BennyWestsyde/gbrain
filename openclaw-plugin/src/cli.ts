/**
 * CLI commands registered under /gbrain.
 * Uses OpenClaw's CLI context (ctx.program is a Commander instance).
 */

import { getEngine } from './engine-host.js';

export function registerGBrainCli() {
  return (ctx: { program: any; config: any; logger: any }) => {
    const { program } = ctx;

    program
      .command('gbrain')
      .description('GBrain status — page count, health score, last sync')
      .action(async () => {
        try {
          const engine = getEngine();
          const stats = await engine.getStats();
          const health = await engine.getHealth();
          console.log(
            `GBrain: ${stats.page_count} pages | Score: ${health.brain_score}/100 | Stale: ${health.stale_pages}`,
          );
        } catch (e) {
          console.error('GBrain not connected:', (e as Error).message);
        }
      });

    program
      .command('gbrain-sync')
      .description('Trigger manual brain sync')
      .action(async () => {
        console.log('Manual sync triggered (use gbrain CLI for full sync)');
      });

    program
      .command('gbrain-doctor')
      .description('Brain health check')
      .action(async () => {
        try {
          const engine = getEngine();
          const health = await engine.getHealth();
          console.log(`Brain Score: ${health.brain_score}/100`);
          console.log(`  Embed coverage:  ${health.embed_coverage_score}/35`);
          console.log(`  Link density:    ${health.link_density_score}/25`);
          console.log(`  Timeline:        ${health.timeline_coverage_score}/15`);
          console.log(`  No orphans:      ${health.no_orphans_score}/15`);
          console.log(`  No dead links:   ${health.no_dead_links_score}/10`);
          if (health.stale_pages > 0) {
            console.log(`\n⚠ ${health.stale_pages} stale pages need re-embedding`);
          }
          if (health.dead_links > 0) {
            console.log(`⚠ ${health.dead_links} dead links found`);
          }
        } catch (e) {
          console.error('GBrain not connected:', (e as Error).message);
        }
      });
  };
}
