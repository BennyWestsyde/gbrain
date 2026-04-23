/**
 * Background service — manages engine lifecycle and periodic sync.
 */

import { initEngine, shutdownEngine } from './engine-host.js';
import type { GBrainPluginConfig } from './config.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

let syncTimer: ReturnType<typeof setInterval> | null = null;
let lastGitHead: string | null = null;

function readGitHead(brainPath: string): string | null {
  try {
    const headPath = join(brainPath, '.git', 'HEAD');
    if (!existsSync(headPath)) return null;
    const head = readFileSync(headPath, 'utf-8').trim();
    if (head.startsWith('ref: ')) {
      const refPath = join(brainPath, '.git', head.slice(5));
      if (existsSync(refPath)) {
        return readFileSync(refPath, 'utf-8').trim();
      }
    }
    return head;
  } catch {
    return null;
  }
}

export function createSyncService(config: GBrainPluginConfig) {
  return {
    id: 'gbrain-sync',

    async start() {
      if (!config.databaseUrl) {
        console.error('[gbrain] No databaseUrl configured — skipping engine init');
        return;
      }

      await initEngine(config);
      console.error(`[gbrain] Engine connected. Brain path: ${config.brainPath}`);

      lastGitHead = readGitHead(config.brainPath);

      if (config.autoSync) {
        syncTimer = setInterval(async () => {
          try {
            const currentHead = readGitHead(config.brainPath);
            if (currentHead && currentHead !== lastGitHead) {
              console.error(
                `[gbrain] Git HEAD changed (${lastGitHead?.slice(0, 8)} → ${currentHead.slice(0, 8)}), sync needed`,
              );
              lastGitHead = currentHead;
              // Full sync integration uses the existing gbrain sync pipeline
              // For now we detect changes; sync orchestration is a follow-up
            }
          } catch (e) {
            console.error('[gbrain] Sync check error:', e);
          }
        }, config.syncIntervalSeconds * 1000);
      }
    },

    async stop() {
      if (syncTimer) {
        clearInterval(syncTimer);
        syncTimer = null;
      }
      await shutdownEngine();
      console.error('[gbrain] Engine disconnected.');
    },
  };
}
