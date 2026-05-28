export const DOMAIN_STORE_MODULE = 'domainStore';

export type DomainStoreModuleName = typeof DOMAIN_STORE_MODULE;

export interface DomainStoreScaffold {
  readonly module: DomainStoreModuleName;
  readonly description: 'Domain state scaffold';
}

export const domainStoreScaffold: DomainStoreScaffold = {
  module: DOMAIN_STORE_MODULE,
  description: 'Domain state scaffold',
};
