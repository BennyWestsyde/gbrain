/**
 * GBrain OpenClaw Plugin — native tool registration for personal knowledge brains.
 *
 * Registers 7 tools that agents discover automatically:
 *   gbrain_search    — Hybrid search (keyword + semantic via RRF)
 *   gbrain_get       — Direct page read by slug
 *   gbrain_resolve   — Entity resolution (name → page)
 *   gbrain_graph     — Relationship traversal
 *   gbrain_timeline  — Temporal queries
 *   gbrain_ingest    — Create/update brain pages
 *   gbrain_stats     — Brain health and statistics
 *
 * Plus a background service for engine lifecycle and /gbrain CLI commands.
 */

import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { resolveConfig } from './config.js';
import { createSyncService } from './service.js';
import { registerGBrainCli } from './cli.js';

// Tool schemas and executors
import { gbrainSearchSchema, executeSearch } from './tools/search.js';
import { gbrainGetSchema, executeGet } from './tools/get.js';
import { gbrainResolveSchema, executeResolve } from './tools/resolve.js';
import { gbrainGraphSchema, executeGraph } from './tools/graph.js';
import { gbrainTimelineSchema, executeTimeline } from './tools/timeline.js';
import { gbrainIngestSchema, executeIngest } from './tools/ingest.js';
import { gbrainStatsSchema, executeStats } from './tools/stats.js';

export default definePluginEntry({
  id: 'gbrain',
  name: 'GBrain',
  description:
    'Personal knowledge brain — semantic search, entity resolution, ' +
    'relationship graph, and enrichment for markdown repos',

  register(api) {
    const config = resolveConfig(api.config as Record<string, unknown>);

    // ── Tools ────────────────────────────────────────────────────────────

    api.registerTool({
      name: 'gbrain_search',
      label: 'GBrain Search',
      description:
        'Search the knowledge brain using hybrid semantic + keyword search. ' +
        'Returns ranked page excerpts with source paths. Use for any question about ' +
        'people, companies, deals, meetings, projects, or concepts in the brain.',
      parameters: gbrainSearchSchema,
      async execute(_toolCallId: string, params: any) {
        return executeSearch(params as Record<string, unknown>);
      },
    } as any);

    api.registerTool({
      name: 'gbrain_get',
      label: 'GBrain Get',
      description:
        'Read a brain page by its slug. Returns the full compiled truth section, ' +
        'optionally with timeline entries and link/backlink graph.',
      parameters: gbrainGetSchema,
      async execute(_toolCallId: string, params: any) {
        return executeGet(params as Record<string, unknown>);
      },
    } as any);

    api.registerTool({
      name: 'gbrain_resolve',
      label: 'GBrain Resolve',
      description:
        'Resolve a name, company, or reference to its brain page. ' +
        'Uses exact slug match → keyword search cascade.',
      parameters: gbrainResolveSchema,
      async execute(_toolCallId: string, params: any) {
        return executeResolve(params as Record<string, unknown>);
      },
    } as any);

    api.registerTool({
      name: 'gbrain_graph',
      label: 'GBrain Graph',
      description:
        'Traverse entity relationships in the knowledge brain. Returns connected ' +
        'pages with relationship types and context.',
      parameters: gbrainGraphSchema,
      async execute(_toolCallId: string, params: any) {
        return executeGraph(params as Record<string, unknown>);
      },
    } as any);

    api.registerTool({
      name: 'gbrain_timeline',
      label: 'GBrain Timeline',
      description:
        'Query temporal changes for a brain entity. Returns dated timeline entries. ' +
        'Supports relative dates like "7d", "30d".',
      parameters: gbrainTimelineSchema,
      async execute(_toolCallId: string, params: any) {
        return executeTimeline(params as Record<string, unknown>);
      },
    } as any);

    api.registerTool({
      name: 'gbrain_ingest',
      label: 'GBrain Ingest',
      description:
        'Create or update a brain page with automatic re-indexing. Can create new ' +
        'pages, prepend timeline entries, or replace compiled truth sections.',
      parameters: gbrainIngestSchema,
      async execute(_toolCallId: string, params: any) {
        return executeIngest(params as Record<string, unknown>);
      },
    } as any);

    api.registerTool({
      name: 'gbrain_stats',
      label: 'GBrain Stats',
      description:
        'Get brain health statistics — page count, embed coverage, link density, ' +
        'brain score, most connected entities, and orphan/stale page counts.',
      parameters: gbrainStatsSchema,
      async execute(_toolCallId: string, _params: any) {
        return executeStats();
      },
    } as any);

    // ── Background Service ──────────────────────────────────────────────

    api.registerService(createSyncService(config) as any);

    // ── CLI ─────────────────────────────────────────────────────────────

    api.registerCli(registerGBrainCli() as any, { commands: ['gbrain', 'gbrain-sync', 'gbrain-doctor'] });
  },
});
