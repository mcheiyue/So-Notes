export const STORAGE_SERVICE_MODULE = 'StorageService';

export type StorageServiceModuleName = typeof STORAGE_SERVICE_MODULE;

export interface StorageServiceScaffold {
  readonly module: StorageServiceModuleName;
  readonly description: 'Domain persistence service scaffold';
}

export const storageServiceScaffold: StorageServiceScaffold = {
  module: STORAGE_SERVICE_MODULE,
  description: 'Domain persistence service scaffold',
};
