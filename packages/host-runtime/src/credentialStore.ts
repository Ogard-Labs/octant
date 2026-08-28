export interface CredentialStore {
  readonly set: (providerInstanceId: string, credential: string) => Promise<void>;
  readonly has: (providerInstanceId: string) => Promise<boolean>;
  readonly resolve: (providerInstanceId: string) => Promise<string>;
  readonly delete: (providerInstanceId: string) => Promise<void>;
}

export type CredentialStoreFailureCategory = "failed" | "invalid" | "missing" | "unavailable";

const FAILURE_MESSAGES: Readonly<Record<CredentialStoreFailureCategory, string>> = {
  failed: "The secure credential operation failed.",
  invalid: "The credential request is invalid.",
  missing: "No credential is stored for this provider.",
  unavailable: "The secure credential store is unavailable.",
};

export class CredentialStoreFailure extends Error {
  constructor(readonly category: CredentialStoreFailureCategory) {
    super(FAILURE_MESSAGES[category]);
    this.name = "CredentialStoreFailure";
  }
}

export type CredentialPurgeFailureCategory = "locked" | "unavailable" | "indeterminate" | "failed";

const PURGE_FAILURE_MESSAGES: Readonly<Record<CredentialPurgeFailureCategory, string>> = {
  locked: "The macOS Keychain is locked or requires interaction.",
  unavailable: "The macOS Keychain is unavailable.",
  indeterminate: "The Keychain credential purge outcome could not be confirmed.",
  failed: "The Keychain credential purge failed.",
};

export class CredentialPurgeFailure extends Error {
  constructor(readonly category: CredentialPurgeFailureCategory) {
    super(PURGE_FAILURE_MESSAGES[category]);
    this.name = "CredentialPurgeFailure";
  }
}

export type CredentialPurgeResult =
  | { readonly dryRun: true; readonly matchedCount: number }
  | { readonly dryRun: false; readonly deletedCount: number; readonly failedCount: number };

export interface CredentialPurgeInput {
  readonly dryRun: boolean;
  /**
   * Exact provider identities referenced by the selected SQLite store.
   * Platform stores use this list to scope legacy credential removal.
   */
  readonly providerInstanceIds: readonly string[];
  /** Public evidence that attributes a pre-scope host identity to this store. */
  readonly hostIdentityFingerprint?: string;
}

export interface CredentialPurgeStore {
  /**
   * Enumerates and, when `dryRun` is false, deletes only credentials owned by
   * the selected store. A nonzero failedCount is not a completed purge.
   */
  readonly purge: (input: CredentialPurgeInput) => Promise<CredentialPurgeResult>;
}
