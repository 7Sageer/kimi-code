import type { HostFileStat, IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { TextWriteInput, TextFileResult } from '#/os/interface/fileOperations';
import { isHostFsNotFound } from '#/os/interface/hostFsErrors';

export async function writeText(fs: IHostFileSystem, input: TextWriteInput): Promise<TextFileResult> {
  const parentError = await ensureParentDirectory(fs, input.parent);
  if (parentError !== undefined) return { isError: true, output: parentError };
  return writeTextResult(input, () => input.mode === 'append' ? fs.appendText(input.path, input.content) : fs.writeText(input.path, input.content));
}

export async function writeTextResult(input: TextWriteInput, write: () => Promise<void>): Promise<TextFileResult> {
  try {
    const mode = input.mode;
    await write();
    const bytesWritten = Buffer.byteLength(input.content, 'utf8');
    return {
      output: `${mode === 'append' ? 'Appended' : 'Wrote'} ${String(bytesWritten)} bytes to ${input.displayPath}`,
    };
  } catch (error) {
    if (isHostFsNotFound(error)) {
      return {
        isError: true,
        output: `Failed to write ${input.displayPath}: parent directory does not exist.`,
      };
    }
    return {
      isError: true,
      output: error instanceof Error ? error.message : String(error),
    };
  }

}

export async function ensureParentDirectory(fs: IHostFileSystem, parent: string): Promise<string | undefined> {
  let stat: HostFileStat;
  try {
    stat = await fs.stat(parent);
  } catch (error) {
    if (isHostFsNotFound(error)) {
      try {
        await fs.mkdir(parent, { recursive: true });
        return undefined;
      } catch (mkdirError) {
        return mkdirError instanceof Error ? mkdirError.message : String(mkdirError);
      }
    }
    return undefined;
  }
  if (!stat.isDirectory) {
    return `Parent path is not a directory: ${parent}.`;
  }
  return undefined;
}
