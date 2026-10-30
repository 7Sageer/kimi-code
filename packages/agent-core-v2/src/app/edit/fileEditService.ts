import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';

import { editText } from '#/os/operations/editText';
import { type FileEditInput, type FileEditResult, IFileEditService } from './fileEdit';

export class FileEditService implements IFileEditService {
  declare readonly _serviceBrand: undefined;

  constructor(@IHostFileSystem private readonly fs: IHostFileSystem) {}

  async edit(input: FileEditInput, fs: IHostFileSystem = this.fs): Promise<FileEditResult> {
    return fs.operations === undefined ? editText(fs, input) : fs.operations.editText(input);
  }
}

registerScopedService(
  LifecycleScope.App,
  IFileEditService,
  FileEditService,
  ScopeActivation.OnScopeCreated,
  'edit',
);
