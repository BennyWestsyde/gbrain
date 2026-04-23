/**
 * Engine host — manages the singleton BrainEngine lifecycle.
 */

import type { BrainEngine } from '../../src/core/engine.ts';
import { createEngine } from '../../src/core/engine-factory.ts';
import type { GBrainPluginConfig } from './config.js';

let engine: BrainEngine | null = null;
let config: GBrainPluginConfig | null = null;

export async function initEngine(cfg: GBrainPluginConfig): Promise<BrainEngine> {
  config = cfg;
  engine = await createEngine({
    database_url: cfg.databaseUrl,
    engine: 'postgres',
  });
  await engine.connect({ database_url: cfg.databaseUrl, engine: 'postgres' });
  return engine;
}

export function getEngine(): BrainEngine {
  if (!engine) {
    throw new Error(
      'GBrain engine not initialized. Ensure the gbrain plugin service is running ' +
      'and databaseUrl is configured.',
    );
  }
  return engine;
}

export function getConfig(): GBrainPluginConfig {
  if (!config) {
    throw new Error('GBrain plugin config not initialized.');
  }
  return config;
}

export async function shutdownEngine(): Promise<void> {
  if (engine) {
    await engine.disconnect();
    engine = null;
  }
}
