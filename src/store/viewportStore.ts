export const VIEWPORT_STORE_MODULE = 'viewportStore';

export type ViewportStoreModuleName = typeof VIEWPORT_STORE_MODULE;

export interface ViewportStoreScaffold {
  readonly module: ViewportStoreModuleName;
  readonly description: 'Viewport state scaffold';
}

export const viewportStoreScaffold: ViewportStoreScaffold = {
  module: VIEWPORT_STORE_MODULE,
  description: 'Viewport state scaffold',
};
