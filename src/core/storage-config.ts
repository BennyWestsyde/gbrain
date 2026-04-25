import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';

export interface StorageConfig {
  git_tracked: string[];
  supabase_only: string[];
}

export interface GBrainYamlConfig {
  storage?: StorageConfig;
}

/**
 * Load gbrain.yml configuration from the brain repository root.
 * Returns null if no configuration file exists.
 */
export function loadStorageConfig(repoPath?: string): StorageConfig | null {
  if (!repoPath) return null;

  const yamlPath = join(repoPath, 'gbrain.yml');
  if (!existsSync(yamlPath)) return null;

  try {
    const content = readFileSync(yamlPath, 'utf-8');
    const parsed = matter(content);
    const config = parsed.data as GBrainYamlConfig;
    return config.storage || null;
  } catch (error) {
    console.warn(`Warning: Failed to parse gbrain.yml: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Validate storage configuration for conflicts and issues.
 */
export function validateStorageConfig(config: StorageConfig): string[] {
  const warnings: string[] = [];
  
  // Check for overlap between git_tracked and supabase_only
  const gitSet = new Set(config.git_tracked);
  const supabaseSet = new Set(config.supabase_only);
  
  for (const path of config.supabase_only) {
    if (gitSet.has(path)) {
      warnings.push(`Directory "${path}" appears in both git_tracked and supabase_only`);
    }
  }
  
  // Check if directories end with / for consistency
  const allPaths = [...config.git_tracked, ...config.supabase_only];
  for (const path of allPaths) {
    if (!path.endsWith('/')) {
      warnings.push(`Directory path "${path}" should end with "/" for consistency`);
    }
  }
  
  return warnings;
}

/**
 * Check if a slug matches any of the storage tier patterns.
 */
export function isGitTracked(slug: string, config: StorageConfig): boolean {
  return config.git_tracked.some(dir => slug.startsWith(dir));
}

export function isSupabaseOnly(slug: string, config: StorageConfig): boolean {
  return config.supabase_only.some(dir => slug.startsWith(dir));
}

/**
 * Determine storage tier for a slug.
 */
export type StorageTier = 'git_tracked' | 'supabase_only' | 'unspecified';

export function getStorageTier(slug: string, config: StorageConfig): StorageTier {
  if (isGitTracked(slug, config)) return 'git_tracked';
  if (isSupabaseOnly(slug, config)) return 'supabase_only';
  return 'unspecified';
}