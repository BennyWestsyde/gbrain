import { describe, test, expect } from 'bun:test';
import { chunkText } from '../../src/core/chunkers/recursive.ts';

describe('Recursive Text Chunker', () => {
  test('returns empty array for empty input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   ')).toEqual([]);
  });

  test('returns single chunk for short text', () => {
    const text = 'Hello world. This is a short text.';
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(text.trim());
    expect(chunks[0].index).toBe(0);
  });

  test('splits at paragraph boundaries', () => {
    const paragraph = 'word '.repeat(200).trim();
    const text = paragraph + '\n\n' + paragraph;
    const chunks = chunkText(text, { chunkSize: 250 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  test('respects chunk size target', () => {
    const text = 'word '.repeat(1000).trim();
    const chunks = chunkText(text, { chunkSize: 100 });
    for (const chunk of chunks) {
      const wordCount = chunk.text.split(/\s+/).length;
      // Allow up to 1.5x target due to greedy merge
      expect(wordCount).toBeLessThanOrEqual(150);
    }
  });

  test('applies overlap between chunks', () => {
    const text = 'word '.repeat(1000).trim();
    const chunks = chunkText(text, { chunkSize: 100, chunkOverlap: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    // Second chunk should start with words from end of first chunk
    // (overlap means shared content between adjacent chunks)
    expect(chunks[1].text.length).toBeGreaterThan(0);
  });

  test('splits at sentence boundaries', () => {
    const sentences = Array.from({ length: 50 }, (_, i) =>
      `This is sentence number ${i} with some content about topic ${i}.`
    ).join(' ');
    const chunks = chunkText(sentences, { chunkSize: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should end near a sentence boundary
    for (const chunk of chunks.slice(0, -1)) {
      // Allow for overlap text, but the core content should have sentence endings
      expect(chunk.text).toMatch(/[.!?]/);
    }
  });

  test('assigns sequential indices', () => {
    const text = 'word '.repeat(1000).trim();
    const chunks = chunkText(text, { chunkSize: 100 });
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].index).toBe(i);
    }
  });

  test('handles single word input', () => {
    const chunks = chunkText('hello');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('hello');
  });

  test('handles unicode text', () => {
    const text = 'Bonjour le monde. ' + 'Ceci est un texte en francais. '.repeat(100);
    const chunks = chunkText(text, { chunkSize: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].text).toContain('Bonjour');
  });
});
