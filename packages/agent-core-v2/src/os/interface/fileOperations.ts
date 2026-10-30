import type { ToolResultSpill } from '#/_base/text/outputLimits';
import type { HostFileStat } from './hostFileSystem';

export const TEXT_PAGE_MAX_REMOTE_CHARS = 4_000_000;

export interface TextFileResult {
  readonly output: string;
  readonly note?: string;
  readonly isError?: boolean;
  readonly truncated?: boolean;
  readonly spill?: ToolResultSpill;
}

export interface TextPageInput {
  readonly path: string;
  readonly line_offset?: number;
  readonly column_offset?: number;
  readonly n_lines?: number;
  readonly max_chars?: number;
}

export interface TextPageOptions {
  readonly args: TextPageInput;
  readonly maxChars: number;
  readonly maxCharsLimit: number;
  readonly eventLog: boolean;
  readonly imageSupported: boolean;
  readonly videoSupported: boolean;
  readonly mediaToolAvailable: boolean;
}

export interface FileReadSource {
  readonly name: string;
  readonly localPath?: string;
  stat(): Promise<HostFileStat>;
  readBytes(n?: number): Promise<Uint8Array>;
  readLines(): AsyncIterable<string>;
  readTextPage?(options: TextPageOptions, signal?: AbortSignal): Promise<TextFileResult>;
}

export interface TextEditInput {
  readonly path: string;
  readonly displayPath: string;
  readonly old_string: string;
  readonly new_string: string;
  readonly replace_all: boolean;
}

export type TextEditResult =
  | { readonly ok: true; readonly count: number }
  | { readonly ok: false; readonly error: string };

export interface TextWriteInput {
  readonly path: string;
  readonly displayPath: string;
  readonly parent: string;
  readonly content: string;
  readonly mode: 'overwrite' | 'append';
}

export interface FileSnapshotRequest {
  readonly path: string;
  readonly knownHash?: string;
}

export type FileSnapshot =
  | { readonly kind: 'missing' | 'unreadable' }
  | { readonly kind: 'oversize'; readonly size: number; readonly mtimeMs?: number }
  | { readonly kind: 'file'; readonly contentHash: string; readonly bytes?: Uint8Array };

export interface GitWorkTree {
  readonly root: string;
  readonly dotGitPath: string;
  readonly controlDirPath: string;
}

export interface FileMatchOptions {
  readonly pattern: string;
  readonly regex: boolean;
  readonly case_sensitive: boolean;
  readonly context_lines: number;
  readonly max_files: number;
  readonly max_matches_per_file: number;
  readonly max_total_matches: number;
}

export interface FileMatch {
  readonly line: number;
  readonly col: number;
  readonly text: string;
  readonly before: string[];
  readonly after: string[];
}

export interface FileMatches {
  readonly responseTooLarge?: boolean;
  readonly files: { path: string; matches: FileMatch[] }[];
  readonly files_scanned: number;
  readonly truncated: boolean;
}

export interface FileMatchPath {
  readonly path: string;
  readonly absolute: string;
}

export interface HostFileOperations {
  matchFiles(files: readonly FileMatchPath[], options: FileMatchOptions, timeoutMs: number): Promise<FileMatches>;
  findGitWorkTree(cwd: string): Promise<GitWorkTree | null>;
  discoverInstructions(dirs: readonly string[], known: readonly string[]): Promise<readonly string[]>;
  snapshotFiles(files: readonly FileSnapshotRequest[], maxFileBytes: number): Promise<readonly FileSnapshot[]>;
  writeText(input: TextWriteInput): Promise<TextFileResult>;
  readTextPage(path: string, options: TextPageOptions, signal?: AbortSignal): Promise<TextFileResult>;
  editText(input: TextEditInput): Promise<TextEditResult>;
}
