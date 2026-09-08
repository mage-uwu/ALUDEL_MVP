/** Vault is completed paperwork; Field dispatches are forms available to fill. */
export interface VaultFilters {
  template: string;
  site: string;
  from: string;
  to: string;
  timezone: string;
}

export interface VaultOption {
  id: string;
  name: string;
  reports: number;
  address?: string;
}

export interface VaultCatalog {
  templates: VaultOption[];
  sites: VaultOption[];
}

export interface VaultPage<T> {
  reports: T[];
  total: number;
  nextCursor: string | null;
}
