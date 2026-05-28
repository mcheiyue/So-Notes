export const APP_CONTROLLER_MODULE = 'appController';

export type AppControllerModuleName = typeof APP_CONTROLLER_MODULE;

export interface AppControllerScaffold {
  readonly module: AppControllerModuleName;
  readonly description: 'Cross-layer use case controller scaffold';
}

export const appControllerScaffold: AppControllerScaffold = {
  module: APP_CONTROLLER_MODULE,
  description: 'Cross-layer use case controller scaffold',
};
