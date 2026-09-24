// backend/src/util/remote-fs/types.ts

/**
 * Provider-neutral remote-filesystem port for Data Integration source browsing.
 * Every transport (SFTP, FTP, S3) implements it; the introspect routes depend on
 * this interface, not on any one client. readPreview returns RAW rows — header
 * interpretation is added at the route layer in Part 2, not here.
 */

/** A remote entry, classified for the UI's file browser. */
export interface FsEntry {
  name: string;
  type: 'folder' | 'csv' | 'file';
}

/** Result of a directory/prefix listing. */
export type ListResult =
  | { ok: true; entries: FsEntry[] }
  | { ok: false; message: string };

/** Result of a bounded CSV preview: RAW rows (no header interpretation applied). */
export type PreviewResult =
  | { ok: true; rows: string[][] }
  | { ok: false; message: string };

/** The port: list a directory, or read a bounded preview of a file. */
export interface RemoteFileSystem {
  listDir(path: string): Promise<ListResult>;
  readPreview(path: string): Promise<PreviewResult>;
}

/** Classify an entry by name + directory flag (shared by all implementations). */
export function classifyEntry(name: string, isDir: boolean): FsEntry['type'] {
  if (isDir) return 'folder';
  return /\.csv$/i.test(name) ? 'csv' : 'file';
}
