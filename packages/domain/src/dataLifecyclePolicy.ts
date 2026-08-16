// Pure, storage-agnostic policy for the disposable-store data-lifecycle: what a
// migration boundary must do before touching the store, and which local-data
// scopes a destructive operation retains, deletes, or leaves as a named
// out-of-process residual. No filesystem, SQLite, or Effect access lives here so
// the decisions stay deterministic and unit-testable.

/**
 * The decision a startup migration boundary makes before mutating a store.
 *
 * - `up-to-date` never writes.
 * - `upgrade` requires a verified pre-migration backup before applying the
 *   listed pending versions so an interrupted multi-step upgrade can be undone.
 * - `downgrade-refused` refuses to open a store written by a newer binary and
 *   proposes no write at all, leaving the source store untouched.
 */
export type MigrationBackupPlan =
  | { readonly kind: "up-to-date"; readonly version: number }
  | {
      readonly kind: "upgrade";
      readonly fromVersion: number;
      readonly toVersion: number;
      readonly pendingVersions: ReadonlyArray<number>;
    }
  | {
      readonly kind: "downgrade-refused";
      readonly databaseVersion: number;
      readonly latestKnownVersion: number;
    };

export function planMigrationBackup(input: {
  readonly databaseVersion: number;
  readonly knownVersions: ReadonlyArray<number>;
}): MigrationBackupPlan {
  const sorted = [...new Set(input.knownVersions)].sort((left, right) => left - right);
  const latestKnownVersion = sorted.at(-1) ?? 0;

  if (input.databaseVersion > latestKnownVersion) {
    return {
      kind: "downgrade-refused",
      databaseVersion: input.databaseVersion,
      latestKnownVersion,
    };
  }

  const pendingVersions = sorted.filter((version) => version > input.databaseVersion);
  if (pendingVersions.length === 0) {
    return { kind: "up-to-date", version: input.databaseVersion };
  }

  return {
    kind: "upgrade",
    fromVersion: input.databaseVersion,
    toVersion: latestKnownVersion,
    pendingVersions,
  };
}

/**
 * The result of one attempt to purge every Octant-owned OS-keychain
 * credential through the native host credential boundary. `not-integrated`
 * covers both non-macOS platforms and a macOS session with no reachable host
 * credential broker (for example, a purely headless CLI invocation); it is an
 * honest capability gap, not a failure. Every other outcome reflects an actual
 * attempt: `dry-run` and `completed` never partially touch unrelated items,
 * `partial` means some Octant-owned items were deleted and others were not,
 * and `locked` / `unavailable` / `failed` mean the boundary refused or could
 * not enumerate/delete anything at all. `indeterminate` means a destructive
 * request may have reached the Keychain helper but its outcome was not
 * confirmed, so callers must reconcile it before restoring or discarding the
 * local store. None of these carry credential values,
 * account identifiers, or other plaintext — only counts and typed categories.
 */
export type CredentialPurgeAttempt =
  | { readonly kind: "not-integrated" }
  | { readonly kind: "dry-run"; readonly matchedCount: number }
  | { readonly kind: "completed"; readonly deletedCount: number }
  | { readonly kind: "partial"; readonly deletedCount: number; readonly failedCount: number }
  | { readonly kind: "indeterminate" }
  | { readonly kind: "locked" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "failed" };

/**
 * Describes the OS-keychain credential-cleanup boundary for a destructive
 * data-lifecycle operation. `performed` is true only for a fully completed
 * purge with no failed item; every other status (including `partial`) must be
 * treated as not performed so a caller never reports a plaintext-safe but
 * incomplete cleanup as a success. `recoveryGuidance` is a fixed, generic
 * instruction with no filesystem paths, account identifiers, or credential
 * material; `residualReason` is set only for the `not-integrated` gap.
 */
export interface CredentialCleanupBoundary {
  readonly store: "os-keychain";
  readonly performed: boolean;
  readonly status:
    | "not-integrated"
    | "dry-run"
    | "completed"
    | "partial"
    | "indeterminate"
    | "locked"
    | "unavailable"
    | "failed";
  readonly deletedCount: number;
  readonly matchedCount: number;
  readonly residualReason: string | null;
  readonly recoveryGuidance: string | null;
}

const RECOVERY_GUIDANCE: Readonly<
  Record<"locked" | "unavailable" | "failed" | "indeterminate", string>
> = {
  locked:
    "The macOS Keychain is locked or requires interaction. No local data was changed; unlock the Keychain (or re-authenticate) and retry.",
  unavailable:
    "The macOS Keychain is unavailable. No local data was changed; confirm Keychain access is reachable and retry.",
  failed:
    "The Keychain credential cleanup failed. No local data was changed; retry complete local-data removal.",
  indeterminate:
    "The Keychain cleanup outcome could not be confirmed. Local store files remain staged; retry complete local-data removal to reconcile before using this store.",
};

export function classifyCredentialCleanupOutcome(input: {
  readonly platform: string;
  readonly attempt: CredentialPurgeAttempt;
}): CredentialCleanupBoundary {
  const { attempt } = input;
  switch (attempt.kind) {
    case "not-integrated":
      return {
        store: "os-keychain",
        performed: false,
        status: "not-integrated",
        deletedCount: 0,
        matchedCount: 0,
        residualReason:
          input.platform === "darwin"
            ? "no host credential broker was reachable in this session; the native desktop host must complete Keychain cleanup"
            : "no OS keychain integration is available on this platform",
        recoveryGuidance: null,
      };
    case "dry-run":
      return {
        store: "os-keychain",
        performed: false,
        status: "dry-run",
        deletedCount: 0,
        matchedCount: attempt.matchedCount,
        residualReason: null,
        recoveryGuidance: null,
      };
    case "completed":
      return {
        store: "os-keychain",
        performed: true,
        status: "completed",
        deletedCount: attempt.deletedCount,
        matchedCount: attempt.deletedCount,
        residualReason: null,
        recoveryGuidance: null,
      };
    case "partial":
      return {
        store: "os-keychain",
        performed: false,
        status: "partial",
        deletedCount: attempt.deletedCount,
        matchedCount: attempt.deletedCount + attempt.failedCount,
        residualReason: null,
        recoveryGuidance: `Some Octant Keychain credentials, including the host identity when present, were already removed (${attempt.deletedCount}); ${attempt.failedCount} credential(s) could not be removed. Keychain cleanup is incomplete; unlock the Keychain and retry complete local-data removal.`,
      };
    case "indeterminate":
    case "locked":
    case "unavailable":
    case "failed":
      return {
        store: "os-keychain",
        performed: false,
        status: attempt.kind,
        deletedCount: 0,
        matchedCount: 0,
        residualReason: null,
        recoveryGuidance: RECOVERY_GUIDANCE[attempt.kind],
      };
  }
}
