/**
 * Fork: gbrain sources set-backup <id> <external|git>
 *
 * Declares how a source's content is backed up. `external` means the
 * operator backs the tree up outside git (iCloud Drive, Time Machine, ...)
 * and deliberately has no remote, so the backup-coverage check reports the
 * source as info instead of warning `no_remote`. `git` restores the default
 * (remote HEAD verification). Only `sources.config.backup` changes; nothing
 * on disk is touched.
 *
 * Lives in its own module (like sources-set-path.ts) so sources.ts stays
 * under its module-size ratchet ceiling.
 */
import type { BrainEngine } from '../core/engine.ts';
import { normalizeSourceConfig, parseSourceConfig } from '../core/sources-load.ts';

const MODES = ['external', 'git'] as const;

export async function runSetBackup(engine: BrainEngine, args: string[]): Promise<void> {
  const id = args[0];
  const mode = args[1];
  if (!id || !mode || !(MODES as readonly string[]).includes(mode)) {
    console.error('Usage: gbrain sources set-backup <id> <external|git>');
    console.error('  external  this source is backed up outside git (no remote expected);');
    console.error('            the backup check lists it as info instead of warning.');
    console.error('  git       default: verify the source repo against its git remote.');
    process.exit(2);
  }

  const rows = await engine.executeRaw<{ config: unknown }>(
    `SELECT config FROM sources WHERE id = $1 LIMIT 1`,
    [id],
  );
  if (rows.length === 0) {
    console.error(`Error: source "${id}" not found.`);
    console.error(`  Run 'gbrain sources list' to see registered sources.`);
    process.exit(4);
  }

  const config = parseSourceConfig(rows[0]!.config);
  const prior = config.backup === 'external' ? 'external' : 'git';
  if (mode === 'git') delete config.backup;
  else config.backup = 'external';
  // Positional JSONB binds go through ::text::jsonb (CLAUDE.md JSONB rule).
  await engine.executeRaw(
    `UPDATE sources SET config = $1::text::jsonb WHERE id = $2`,
    [JSON.stringify(normalizeSourceConfig(config)), id],
  );
  console.log(`Source "${id}" backup: ${prior} -> ${mode}.`);
  console.log(`  Run 'gbrain backup check' to refresh the cached backup verdict.`);
}
