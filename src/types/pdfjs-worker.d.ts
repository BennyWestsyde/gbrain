// Fork: pdfjs-dist ships no types for the worker entry. extract-text.ts only
// hands the module object to pdfjs via globalThis.pdfjsWorker.
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown;
}
