declare module 'adm-zip' {
  export interface IZipEntry {
    entryName: string;
    getData(): Buffer;
  }

  export default class AdmZip {
    constructor(filePath: string);
    getEntries(): IZipEntry[];
    getEntry(name: string): IZipEntry | null;
  }
}

declare module 'web-tree-sitter' {
  const Parser: any;
  export default Parser;
}
