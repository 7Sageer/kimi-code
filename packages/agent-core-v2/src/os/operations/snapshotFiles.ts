import { createHash } from 'node:crypto';

import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { FileSnapshotRequest, FileSnapshot } from '#/os/interface/fileOperations';
import { isHostFsNotFound } from '#/os/interface/hostFsErrors';

export async function snapshotFiles(fs: IHostFileSystem, files: readonly FileSnapshotRequest[], maxFileBytes: number): Promise<FileSnapshot[]> {
  const results: FileSnapshot[] = [];
  for (const file of files) {
    let inspected = false;
    try {
      const before = await fs.stat(file.path);
      inspected = true;
      if (!before.isFile) {
        results.push({ kind: 'unreadable' });
        continue;
      }
      if (before.size > maxFileBytes) {
        results.push({ kind: 'oversize', size: before.size, mtimeMs: before.mtimeMs });
        continue;
      }
      const bytes = await fs.readBytes(file.path, before.size + 1);
      const after = await fs.stat(file.path);
      if (bytes.byteLength > maxFileBytes) {
        results.push({ kind: 'oversize', size: after.size, mtimeMs: after.mtimeMs });
        continue;
      }
      if (!after.isFile || bytes.byteLength !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
        results.push({ kind: 'unreadable' });
        continue;
      }
      const contentHash = createHash('sha256').update(bytes).digest('hex');
      results.push({ kind: 'file', contentHash, bytes: file.knownHash === contentHash ? undefined : bytes });
    } catch (error) {
      results.push({ kind: !inspected && isHostFsNotFound(error) ? 'missing' : 'unreadable' });
    }
  }
  return results;
}
