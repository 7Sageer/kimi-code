import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { GitWorkTree } from '#/os/interface/fileOperations';
import { findGitWorkTree as findLocalGitWorkTree } from '#/os/operations/gitWorkTree';

export type { GitWorkTree } from '#/os/interface/fileOperations';

export function findGitWorkTree(fs: IHostFileSystem, cwd: string): Promise<GitWorkTree | null> {
  return fs.operations === undefined ? findLocalGitWorkTree(fs, cwd) : fs.operations.findGitWorkTree(cwd);
}
