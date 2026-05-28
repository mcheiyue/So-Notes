export const DATA_TRANSFER_SERVICE_MODULE = 'DataTransferService';

export type DataTransferServiceModuleName = typeof DATA_TRANSFER_SERVICE_MODULE;

export interface DataTransferServiceScaffold {
  readonly module: DataTransferServiceModuleName;
  readonly description: 'Import and export service scaffold';
}

export const dataTransferServiceScaffold: DataTransferServiceScaffold = {
  module: DATA_TRANSFER_SERVICE_MODULE,
  description: 'Import and export service scaffold',
};
