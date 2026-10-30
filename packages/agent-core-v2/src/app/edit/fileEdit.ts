import type { TextEditInput as FileEditInput, TextEditResult as FileEditResult } from '#/os/interface/fileOperations';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

export type { TextEditInput as FileEditInput, TextEditResult as FileEditResult } from '#/os/interface/fileOperations';

export interface IFileEditService {
  readonly _serviceBrand: undefined;

  edit(input: FileEditInput, fs?: IHostFileSystem): Promise<FileEditResult>;
}

export const IFileEditService: ServiceIdentifier<IFileEditService> =
  createDecorator<IFileEditService>('fileEditService');
