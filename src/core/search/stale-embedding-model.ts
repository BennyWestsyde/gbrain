/**
 * A long-running process (an MCP `gbrain serve`, a jobs worker) keeps the
 * embedding model its gateway loaded at start. After `gbrain migrate
 * embeddings` moves the brain to another model, that process still embeds
 * every query with the old model, and its vector arm, which keeps only the
 * chunks of the loaded model, finds nothing: search turns keyword-only
 * without saying so. Hybrid search asks this module first, skips the query
 * embed when the process is stale, and names the restart that fixes it.
 */
import { loadConfig } from '../config.ts';

export interface StaleEmbeddingModel {
  /** The model this process's gateway loaded at start. */
  loaded: string;
  /** The model the config (file plus env) names now. */
  configured: string;
}

export interface StaleEmbeddingModelDeps {
  /** The gateway's loaded model, or null when it has none. */
  loaded?: () => string | null | undefined;
  /** The configured model, read fresh from the config file and env. */
  configured?: () => string | null | undefined;
}

/**
 * Compare the gateway's loaded embedding model with the one the config names
 * now. Reads `~/.gbrain/config.json` (and env) once per call.
 *
 * Returns both models when they differ, else null. Never throws: a process
 * with no config file, no configured model, or no configured gateway (tests,
 * SDK callers that configure the gateway directly) is never stale.
 */
export function staleEmbeddingModel(deps: StaleEmbeddingModelDeps = {}): StaleEmbeddingModel | null {
  try {
    const loaded = (deps.loaded ?? loadedModel)()?.trim();
    const configured = (deps.configured ?? configuredModel)()?.trim();
    if (!loaded || !configured || loaded === configured) return null;
    return { loaded, configured };
  } catch {
    return null;
  }
}

function loadedModel(): string | null {
  // require() avoids a static cycle (the gateway reaches search/ through embedding-column.ts).
  const gw = require('../ai/gateway.ts') as typeof import('../ai/gateway.ts');
  return gw.getEmbeddingModelProvenance();
}

function configuredModel(): string | undefined {
  return loadConfig()?.embedding_model;
}
