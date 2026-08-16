import type { ProviderDriverKind } from "@octant/contracts";

export const PROVIDER_PROJECTION_SCHEMA_VERSION = 1;
export const PROVIDER_DEFAULTS_PROJECTION_KEY = "provider-defaults";
export const PROVIDER_CATALOG_PROJECTION_SCHEMA_VERSION = 1;

export interface ProviderInstanceProjectionRow {
  readonly instance_id: string;
  readonly schema_version: number;
  readonly driver_kind: ProviderDriverKind;
  readonly enabled: number;
  readonly instance_json: string;
  readonly aggregate_version: number;
}

export interface ProviderDefaultsProjectionRow {
  readonly projection_key: string;
  readonly schema_version: number;
  readonly defaults_json: string;
  readonly aggregate_version: number;
}

export interface ProviderCatalogProjectionRow {
  readonly instance_id: string;
  readonly schema_version: number;
  readonly catalog_json: string;
  readonly aggregate_version: number;
}

export function assertProviderProjectionSchema(schemaVersion: number): void {
  if (schemaVersion !== PROVIDER_PROJECTION_SCHEMA_VERSION) {
    throw new Error("unsupported provider projection schema version");
  }
}
