/**
 * The replica-store contribution.
 *
 * A store holds write-once bytes under a key the caller names. It can list
 * what is there, read one key, and publish a key only when that key is
 * absent. It does not replace. Whether a store is offered at all is a host
 * decision; this type is only the port a folder store or a later store
 * implements.
 */

export const REPLICA_STORE_CONTRIBUTION_KIND = "replica-store" as const;
export type ReplicaStoreContributionKind = typeof REPLICA_STORE_CONTRIBUTION_KIND;

/** Whether the store can be used. `refused` is authority; `not-connected` is reach. */
export type ReplicaStoreStatus = "ready" | "not-connected" | "refused";

/**
 * A file in the store that is not an entry.
 *
 * A sync client leaves these behind. They are reported so a pull can say what
 * it skipped, and they are never treated as entries.
 */
export type ReplicaStoreSkipReason = "not-downloaded" | "conflict-copy";

export interface ReplicaStoreSkipReport {
  readonly key: string;
  readonly reason: ReplicaStoreSkipReason;
}

export interface ReplicaStoreListEntry {
  readonly key: string;
}

export type ReplicaStoreListResult =
  | {
      readonly status: "ready";
      readonly entries: ReadonlyArray<ReplicaStoreListEntry>;
      readonly reports: ReadonlyArray<ReplicaStoreSkipReport>;
      readonly nextCursor?: string;
    }
  | { readonly status: "not-connected" }
  | { readonly status: "refused"; readonly reason: "outside-home" };

export type ReplicaStoreGetResult =
  | { readonly status: "ready"; readonly bytes: Uint8Array }
  | { readonly status: "missing" }
  | { readonly status: "not-connected" }
  | {
      readonly status: "refused";
      readonly reason: "outside-home" | "key-refused" | ReplicaStoreSkipReason;
    };

/**
 * `already-exists` means the key was left untouched. The caller must not
 * treat that as a successful publish, and must not retry by replacing.
 */
export type ReplicaStorePutResult =
  | { readonly status: "stored" }
  | { readonly status: "already-exists" }
  | { readonly status: "not-connected" }
  | {
      readonly status: "refused";
      readonly reason: "outside-home" | "key-refused" | "write-failed";
    };

export interface ReplicaStore {
  readonly kind: ReplicaStoreContributionKind;
  readonly status: () => Promise<ReplicaStoreStatus>;
  readonly list: (afterCursor?: string) => Promise<ReplicaStoreListResult>;
  readonly get: (key: string) => Promise<ReplicaStoreGetResult>;
  readonly putIfAbsent: (key: string, bytes: Uint8Array) => Promise<ReplicaStorePutResult>;
}
