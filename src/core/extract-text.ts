/**
 * Text extraction for binary file types: PDF, DOCX, PPTX, XLSX.
 * Returns plain text suitable for chunking and embedding.
 */

import { readFileSync } from 'fs';
import { extname, basename } from 'path';
import { installDOMPolyfills } from './dom-matrix-polyfill.ts';

export type SupportedBinaryExt = '.pdf' | '.docx' | '.pptx' | '.xlsx' | '.doc' | '.rtf';

export const BINARY_EXTENSIONS: Set<string> = new Set([
  '.pdf', '.docx', '.pptx', '.xlsx', '.doc', '.rtf', '.srt', '.vtt',
]);

export function isSupportedBinary(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(extname(filePath).toLowerCase());
}

/**
 * Fork: document files (PDF/Office/RTF/subtitles) that import as text pages.
 * Admitted by sync.ts isAllowedByStrategy and import.ts isCollectibleForWalker
 * under the markdown/auto strategies, mirroring how upstream admits images.
 * Office lock files (`~$foo.docx`) are excluded.
 */
export function isDocumentFilePath(path: string): boolean {
  const base = path.split('/').pop() ?? path;
  return !base.startsWith('~$') && isSupportedBinary(path);
}

/**
 * Extract plain text from a binary file.
 * Returns markdown-formatted text with a title header.
 */
export async function extractText(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();
  const title = basename(filePath, ext);

  switch (ext) {
    case '.pdf':
      return extractPdf(filePath, title);
    case '.docx':
    case '.doc':
      return extractDocx(filePath, title);
    case '.pptx':
      return extractPptx(filePath, title);
    case '.xlsx':
      return extractXlsx(filePath, title);
    case '.rtf':
      return extractRtf(filePath, title);
    case '.srt':
    case '.vtt':
      return extractSubtitles(filePath, title);
    default:
      throw new Error(`Unsupported file type: ${ext}`);
  }
}

async function extractPdf(filePath: string, title: string): Promise<string> {
  // pdfjs-dist v5 needs DOMMatrix & co., which Bun/Node lack in some builds
  // (notably the compiled binary). Only fills globals that are missing.
  installDOMPolyfills();
  // pdfjs's "fake worker" dynamically imports ./pdf.worker.mjs by path, which
  // doesn't exist inside a `bun build --compile` binary ($bunfs). Importing
  // the worker module here bundles it, and pdfjs uses globalThis.pdfjsWorker
  // as its main-thread worker when present.
  const g = globalThis as { pdfjsWorker?: unknown };
  if (!g.pdfjsWorker) g.pdfjsWorker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const buffer = readFileSync(filePath);
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => 'str' in item ? item.str : '')
      .filter(Boolean)
      .join(' ')
      .trim();
    if (pageText) pages.push(pageText);
  }
  const text = pages.join('\n\n').trim();
  if (!text) throw new Error('PDF contains no extractable text (may be scanned image)');
  return `# ${title}\n\n${text}`;
}

async function extractDocx(filePath: string, title: string): Promise<string> {
  const mammoth = await import('mammoth');
  const buffer = readFileSync(filePath);
  const result = await mammoth.extractRawText({ buffer });
  const text = result.value.trim();
  if (!text) throw new Error('DOCX contains no extractable text');
  return `# ${title}\n\n${text}`;
}

async function extractPptx(filePath: string, title: string): Promise<string> {
  const AdmZip = (await import('adm-zip')).default;
  const zip = new AdmZip(filePath);
  const entries: Array<{ entryName: string; getData(): Buffer }> = zip.getEntries();

  // Extract text from slide XML files in order
  const slideEntries = entries
    .filter(e => e.entryName.match(/^ppt\/slides\/slide\d+\.xml$/))
    .sort((a, b) => {
      const numA = parseInt(a.entryName.match(/slide(\d+)/)?.[1] ?? '0');
      const numB = parseInt(b.entryName.match(/slide(\d+)/)?.[1] ?? '0');
      return numA - numB;
    });

  if (slideEntries.length === 0) throw new Error('No slides found in PPTX');

  const slideTexts: string[] = [];

  for (let i = 0; i < slideEntries.length; i++) {
    const xml = slideEntries[i].getData().toString('utf-8');
    const text = stripXmlTags(xml).trim();
    if (text) {
      slideTexts.push(`## Slide ${i + 1}\n\n${text}`);
    }
  }

  if (slideTexts.length === 0) throw new Error('PPTX contains no extractable text');
  return `# ${title}\n\n${slideTexts.join('\n\n')}`;
}

async function extractXlsx(filePath: string, title: string): Promise<string> {
  const AdmZip = (await import('adm-zip')).default;
  const zip = new AdmZip(filePath);

  // Extract shared strings (the actual cell text values)
  const sharedStringsEntry = zip.getEntry('xl/sharedStrings.xml');
  const sharedStrings: string[] = [];

  if (sharedStringsEntry) {
    const xml = sharedStringsEntry.getData().toString('utf-8');
    const matches = xml.matchAll(/<t[^>]*>([^<]*)<\/t>/g);
    for (const m of matches) {
      if (m[1].trim()) sharedStrings.push(m[1].trim());
    }
  }

  if (sharedStrings.length === 0) throw new Error('XLSX contains no extractable text');
  return `# ${title}\n\n${sharedStrings.join('\n')}`;
}

function extractRtf(filePath: string, title: string): string {
  const content = readFileSync(filePath, 'latin1');
  // Strip RTF control words and groups, keep plain text
  const text = content
    .replace(/\{[^{}]*\}/g, ' ')           // remove groups
    .replace(/\\[a-z]+[-]?\d* ?/g, ' ')    // remove control words
    .replace(/\\\n/g, '\n')                 // line breaks
    .replace(/[{}\\]/g, '')                 // remaining braces/backslashes
    .replace(/ {2,}/g, ' ')                 // collapse spaces
    .trim();
  if (!text) throw new Error('RTF contains no extractable text');
  return `# ${title}\n\n${text}`;
}

/**
 * Extract subtitle text from SRT or WebVTT files.
 *
 * Both formats interleave timing metadata with the actual subtitle
 * strings. We keep only the strings — the timings are useful only for
 * playback, and embedding search over a bag of "00:12:34,120 -->"
 * timestamps would poison the vector for the underlying content.
 *
 * The two formats differ enough at the header/cue boundary that we
 * strip both patterns rather than switch on extension: SRT cues open
 * with a numeric sequence line, WebVTT with an optional `WEBVTT`
 * header and no sequence numbers. Ignoring both means the same code
 * path handles either.
 */
function extractSubtitles(filePath: string, title: string): string {
  const content = readFileSync(filePath, 'utf-8');
  const lines: string[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // WebVTT header
    if (line === 'WEBVTT' || line.startsWith('WEBVTT ')) continue;
    // Cue timing line (SRT: `00:00:12,300 --> ...`; VTT: `00:00:12.300 --> ...`)
    if (/-->/.test(line)) continue;
    // Bare SRT sequence number (a line consisting only of digits)
    if (/^\d+$/.test(line)) continue;
    // WebVTT cue metadata (NOTE / STYLE / cue identifiers with `align:`)
    if (line.startsWith('NOTE') || line.startsWith('STYLE')) continue;
    // Strip inline HTML-ish tags (VTT allows <b>, <i>, <c.name>, ...)
    lines.push(line.replace(/<[^>]+>/g, '').trim());
  }
  const text = lines.filter(Boolean).join('\n').trim();
  if (!text) throw new Error('Subtitle file contains no extractable text');
  return `# ${title}\n\n${text}`;
}

/** Strip all XML tags and decode common entities, preserving whitespace between elements. */
function stripXmlTags(xml: string): string {
  return xml
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
