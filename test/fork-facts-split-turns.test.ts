/**
 * Fork (hearth#36): the page backstop reads a long page to the end.
 *
 * The extractor cut every turn at MAX_TURN_TEXT_CHARS (8,000), and the page
 * backstop passes a whole page as one turn, so a busy day's email digest
 * (up to ~45k chars) lost most of its messages. With `splitLongTurn` the
 * page is extracted as several turns, split on digest-entry boundaries.
 *
 * Uses the gateway chat-transport test seam — no API key, no network.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  __setChatTransportForTests,
} from '../src/core/ai/gateway.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
import {
  extractFactsFromTurnWithOutcome,
  MAX_TURN_CHUNKS,
  splitTurnText,
} from '../src/core/facts/extract.ts';

beforeEach(() => {
  resetGateway();
  __setChatTransportForTests(null);
  configureGateway({
    chat_model: 'anthropic:claude-sonnet-4-6',
    env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
});

afterAll(() => {
  __setChatTransportForTests(null);
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ...process.env },
  });
});

function chatResult(text: string, stopReason: ChatResult['stopReason'] = 'end'): ChatResult {
  return {
    text,
    blocks: [{ type: 'text', text }],
    stopReason,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-sonnet-4-6',
    providerId: 'anthropic',
  } as ChatResult;
}

function oneFact(n: number): string {
  return JSON.stringify({ facts: [{
    fact: `fact from turn ${n}`, kind: 'event', entity: null, confidence: 0.9,
    notability: 'high', metric: null, value: null, unit: null, period: null,
  }] });
}

/** A digest page shaped like hearth's: a header, then ~800-char entries. */
function digest(entries: number): string {
  const body = Array.from({ length: entries }, (_, i) =>
    `- **[${String(i).padStart(2, '0')}:00] Sender ${i}** Subject ${i}\n  ${'x'.repeat(740)} <END${i}>`,
  );
  return `# Email digest\n\nMessages received today.\n\n${body.join('\n')}`;
}

/** The turn text inside one extractor request. */
function turnOf(opts: ChatOpts): string {
  const content = String((opts.messages[0] as { content: unknown }).content);
  return content.slice(content.indexOf('<turn>\n') + 7, content.indexOf('\n</turn>'));
}

describe('splitTurnText', () => {
  test('a short page is one turn', () => {
    expect(splitTurnText('short page')).toEqual(['short page']);
  });

  test('a digest splits on entry boundaries, every turn under the cap, nothing lost', () => {
    const page = digest(59);
    const turns = splitTurnText(page);
    expect(turns.length).toBe(Math.ceil(page.length / 8000));
    for (const t of turns) expect(t.length).toBeLessThanOrEqual(8000);
    for (const t of turns.slice(1)) expect(t.startsWith('- **[')).toBe(true);
    for (let i = 0; i < 59; i++) {
      expect(turns.filter(t => t.includes(`<END${i}>`))).toHaveLength(1);
    }
  });

  test('appending entries leaves the earlier turns unchanged', () => {
    const before = splitTurnText(digest(30));
    const after = splitTurnText(digest(40));
    expect(after.slice(0, before.length - 1)).toEqual(before.slice(0, -1));
  });

  test('without entries it cuts at a blank line, else mid-line', () => {
    const paragraphs = Array.from({ length: 20 }, () => 'y'.repeat(999)).join('\n\n');
    for (const t of splitTurnText(paragraphs)) {
      expect(t.length).toBeLessThanOrEqual(8000);
      expect(t.length % 1001).toBe(999);  // whole paragraphs only
    }
    const oneLine = 'z'.repeat(20_000);
    expect(splitTurnText(oneLine).map(t => t.length)).toEqual([8000, 8000, 4000]);
  });
});

describe('extractFactsFromTurnWithOutcome with splitLongTurn', () => {
  test('a long page is extracted as several turns and the facts concatenated', async () => {
    const seen: ChatOpts[] = [];
    __setChatTransportForTests(async (opts) => {
      seen.push(opts);
      return chatResult(oneFact(seen.length));
    });
    const page = digest(25);  // ~20k chars
    const outcome = await extractFactsFromTurnWithOutcome({
      turnText: page, source: 'mcp:put_page', splitLongTurn: true,
    });
    expect(outcome.ok).toBe(true);
    expect(seen).toHaveLength(3);
    for (const opts of seen) expect(turnOf(opts).length).toBeLessThanOrEqual(8000);
    expect(turnOf(seen[2]!)).toContain('<END24>');  // the end of the page is read
    expect(outcome.ok && outcome.facts.map(f => f.fact)).toEqual(
      ['fact from turn 1', 'fact from turn 2', 'fact from turn 3']);
  });

  test('without splitLongTurn the turn is still cut at the cap', async () => {
    const seen: ChatOpts[] = [];
    __setChatTransportForTests(async (opts) => {
      seen.push(opts);
      return chatResult(oneFact(1));
    });
    await extractFactsFromTurnWithOutcome({ turnText: digest(25), source: 'mcp:extract_facts' });
    expect(seen).toHaveLength(1);
    expect(turnOf(seen[0]!)).not.toContain('<END24>');
  });

  test('one failing turn fails the whole page, so nothing half-read is published', async () => {
    let calls = 0;
    __setChatTransportForTests(async () => {
      calls++;
      if (calls === 2) throw new Error('upstream 524');
      return chatResult(oneFact(calls));
    });
    const outcome = await extractFactsFromTurnWithOutcome({
      turnText: digest(25), source: 'mcp:put_page', splitLongTurn: true,
    });
    expect(calls).toBe(2);  // stops at the failure
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toBe('provider_error');
  });

  test(`a page over ${MAX_TURN_CHUNKS} turns reads only the first ${MAX_TURN_CHUNKS}`, async () => {
    let calls = 0;
    __setChatTransportForTests(async () => {
      calls++;
      return chatResult(oneFact(calls));
    });
    const outcome = await extractFactsFromTurnWithOutcome({
      turnText: digest(80), source: 'mcp:put_page', splitLongTurn: true,
    });
    expect(calls).toBe(MAX_TURN_CHUNKS);
    expect(outcome.ok && outcome.facts).toHaveLength(MAX_TURN_CHUNKS);
  });
});
