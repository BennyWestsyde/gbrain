// Fork: document (PDF/Office/RTF/subtitle) import. See src/core/extract-text.ts.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { extractText, isDocumentFilePath, NoExtractableTextError } from '../src/core/extract-text.ts';
import { isSyncable, slugifyPath } from '../src/core/sync.ts';

describe('isDocumentFilePath', () => {
  test('admits supported document types, case-insensitively', () => {
    for (const p of ['a.pdf', 'dir/B.DOCX', 'x.pptx', 'x.xlsx', 'x.rtf', 'x.doc', 'class.srt', 'class.vtt']) {
      expect(isDocumentFilePath(p)).toBe(true);
    }
  });

  test('rejects markdown, code, images and Office lock files', () => {
    for (const p of ['a.md', 'a.ts', 'a.png', 'dir/~$Syllabus.docx', '~$x.pptx']) {
      expect(isDocumentFilePath(p)).toBe(false);
    }
  });
});

describe('sync admission', () => {
  test('documents sync under markdown and auto strategies, not code', () => {
    expect(isSyncable('Wills & Trusts/Slides/Lecture 6.pptx', { strategy: 'markdown' })).toBe(true);
    expect(isSyncable('Criminal Procedure/Syllabus.docx', { strategy: 'auto' })).toBe(true);
    expect(isSyncable('Criminal Procedure/Syllabus.docx', { strategy: 'code' })).toBe(false);
  });

  test('document slugs keep the extension (matches existing fork pages)', () => {
    expect(slugifyPath('Board of Barristers/BOB Bylaws 2023-2024.docx'))
      .toBe('board-of-barristers/bob-bylaws-2023-2024.docx');
  });
});

describe('extractText', () => {
  test('subtitles extract to a titled markdown page without timestamps', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-doc-'));
    const srt = join(dir, 'Class 16.srt');
    writeFileSync(srt, '1\n00:00:01,000 --> 00:00:03,000\nThe exclusionary rule\n\n2\n00:00:03,500 --> 00:00:05,000\napplies to the states.\n');
    const text = await extractText(srt);
    expect(text.startsWith('# Class 16')).toBe(true);
    expect(text).toContain('The exclusionary rule');
    expect(text).toContain('applies to the states.');
    expect(text).not.toContain('-->');
  });

  test('a document with no text raises NoExtractableTextError (informational skip upstream)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-doc-'));
    const empty = join(dir, 'blank.srt');
    writeFileSync(empty, '1\n00:00:01,000 --> 00:00:02,000\n\n');
    await expect(extractText(empty)).rejects.toBeInstanceOf(NoExtractableTextError);
  });

  test('unsupported types throw', async () => {
    await expect(extractText('/tmp/whatever.xyz')).rejects.toThrow('Unsupported file type');
  });
});
