/**
 * Plugin config resolution. Merges OpenClaw plugin config with env vars.
 */

export interface GBrainPluginConfig {
  databaseUrl: string;
  brainPath: string;
  openaiApiKey: string;
  autoSync: boolean;
  syncIntervalSeconds: number;
}

export function resolveConfig(raw: Record<string, unknown>): GBrainPluginConfig {
  const databaseUrl =
    (raw['databaseUrl'] as string) ||
    process.env['DATABASE_URL'] ||
    process.env['GBRAIN_DATABASE_URL'] ||
    '';

  const brainPath =
    (raw['brainPath'] as string) ||
    process.env['GBRAIN_BRAIN_PATH'] ||
    './brain';

  const openaiApiKey =
    (raw['openaiApiKey'] as string) ||
    process.env['OPENAI_API_KEY'] ||
    '';

  const autoSync = raw['autoSync'] !== false;

  const syncIntervalSeconds =
    typeof raw['syncIntervalSeconds'] === 'number'
      ? raw['syncIntervalSeconds']
      : 30;

  return { databaseUrl, brainPath, openaiApiKey, autoSync, syncIntervalSeconds };
}
