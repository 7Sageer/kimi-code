import type { TextFileResult } from './fileOperations';

export interface GlobSearchInput {
  readonly pattern: string;
  readonly head_limit?: number;
  readonly offset?: number;
  readonly path?: string;
  readonly include_ignored?: boolean;
  readonly include_dirs?: boolean;
}

export interface GrepSearchInput extends GlobSearchInput {
  readonly glob?: string;
  readonly type?: string;
  readonly output_mode?: 'content' | 'files_with_matches' | 'count_matches';
  readonly '-i'?: boolean;
  readonly '-n'?: boolean;
  readonly '-A'?: number;
  readonly '-B'?: number;
  readonly '-C'?: number;
  readonly multiline?: boolean;
}

export interface SearchRequest {
  readonly kind: 'glob' | 'grep';
  readonly args: GrepSearchInput;
  readonly rgPath: string;
  readonly roots: readonly string[];
  readonly workspaceDir: string;
  readonly pathClass: 'posix' | 'win32';
}

export type SearchResult = TextFileResult;
