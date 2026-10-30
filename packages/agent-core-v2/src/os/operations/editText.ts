import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { TextEditInput, TextEditResult } from '#/os/interface/fileOperations';
import { unwrapErrorCause } from '#/_base/errors/errors';
import { EditService } from './editService';
import { TextModel } from './textModel';

export async function editText(fs: IHostFileSystem, input: TextEditInput): Promise<TextEditResult> {
  try {
    const raw = await fs.readText(input.path, { errors: 'strict' });
    const model = new TextModel(raw);
    const result = new EditService().apply(model, {
      path: input.displayPath,
      old_string: input.old_string,
      new_string: input.new_string,
      replace_all: input.replace_all,
    });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    await fs.writeText(input.path, result.rawContent);
    return { ok: true, count: result.count };
  } catch (error) {
    const code = (unwrapErrorCause(error) as { code?: unknown } | null)?.code;
    if (code === 'EISDIR') {
      return { ok: false, error: `${input.displayPath} is not a file.` };
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
