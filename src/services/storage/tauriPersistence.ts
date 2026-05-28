export const TAURI_PERSISTENCE_MODULE = 'tauriPersistence';

export type TauriPersistenceModuleName = typeof TAURI_PERSISTENCE_MODULE;

export interface TauriPersistenceScaffold {
  readonly module: TauriPersistenceModuleName;
  readonly description: 'Tauri persistence adapter scaffold';
}

export const tauriPersistenceScaffold: TauriPersistenceScaffold = {
  module: TAURI_PERSISTENCE_MODULE,
  description: 'Tauri persistence adapter scaffold',
};
