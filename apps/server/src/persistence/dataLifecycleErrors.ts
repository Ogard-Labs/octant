import { Data } from "effect";

// Typed, redacted failures for backup, restore, and destructive data-lifecycle
// operations. None of these carry filesystem paths, SQL, or event payloads so
// diagnostics stay safe to surface to an operator.

export type BackupVerificationReason =
  | "integrity-check-failed"
  | "not-an-octant-store"
  | "unreadable";

export class StoreBackupFailed extends Data.TaggedError("StoreBackupFailed")<{
  readonly operation: "create";
}> {}

export class BackupVerificationFailed extends Data.TaggedError("BackupVerificationFailed")<{
  readonly reason: BackupVerificationReason;
}> {}

export class StoreRestoreFailed extends Data.TaggedError("StoreRestoreFailed")<{
  readonly stage: "verify-backup" | "swap-store";
}> {}

export class PathOutsideDataDirectory extends Data.TaggedError("PathOutsideDataDirectory")<{
  readonly purpose: "backup" | "restore" | "remove";
}> {}

export class MigrationDowngradeRefused extends Data.TaggedError("MigrationDowngradeRefused")<{
  readonly databaseVersion: number;
  readonly latestKnownVersion: number;
}> {}

export class MigrationInterruptedRestored extends Data.TaggedError("MigrationInterruptedRestored")<{
  readonly fromVersion: number;
  readonly attemptedVersion: number;
  readonly restored: boolean;
}> {}

export class DataLifecycleOperationFailed extends Data.TaggedError("DataLifecycleOperationFailed")<{
  readonly operation: "reset" | "remove-all" | "delete-remote-host";
}> {}

/**
 * A destructive data-lifecycle operation that also needed to purge Octant's
 * OS-keychain credentials refused to run because the Keychain boundary did not
 * report a full, clean success. No filesystem or database mutation happens
 * before this check, so the store, journal, and Keychain are all left exactly
 * as they were. Carries only a typed category and generic recovery guidance —
 * never a credential value, account identifier, or filesystem path.
 */
export class CredentialCleanupBlocked extends Data.TaggedError("CredentialCleanupBlocked")<{
  readonly status:
    | "not-integrated"
    | "locked"
    | "unavailable"
    | "partial"
    | "indeterminate"
    | "failed";
  readonly recoveryGuidance: string;
}> {}
