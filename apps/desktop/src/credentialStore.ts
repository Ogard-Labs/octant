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
