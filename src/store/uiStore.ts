export const UI_STORE_MODULE = 'uiStore';

export type UIStoreModuleName = typeof UI_STORE_MODULE;

export interface UIStoreScaffold {
  readonly module: UIStoreModuleName;
  readonly description: 'UI state scaffold';
}

export const uiStoreScaffold: UIStoreScaffold = {
  module: UI_STORE_MODULE,
  description: 'UI state scaffold',
};
