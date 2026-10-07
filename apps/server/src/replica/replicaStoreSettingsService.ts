/**
 * Which replica store this host uses, and whether sync is on.
 *
 * The choice is journaled whole and rebuilt on restart, so a store a person
 * set up survives one, and the membership service asks this service for its
 * store on every command. Sync starts off. With sync off, or no store chosen,
 * the selection is `not-configured` and nothing opens a store, so a host with
 * sync off makes no store call (decision 0163).
 *
 * A bucket's access key and secret go only into the host credential store
 * (macOS Keychain or freedesktop Secret Service) through the credential
 * broker. The journaled settings hold an opaque reference to that entry and
 * nothing else secret; the view Settings reads says only whether a key pair is
 * saved.
 */

import {
  AggregateVersion,
  LOCAL_HOST_ID,
  type EventActor,
  type UtcTimestamp,
} from "@octant/contracts";
import {
  REPLICA_STORE_SETTINGS_AGGREGATE_TYPE,
  REPLICA_STORE_SETTINGS_CHANGED,
  decodeReplicaStoreSettings,
  decodeReplicaStoreSettingsView,
  type ReplicaStoreChoice,
  type ReplicaStoreConnectionOutcome,
  type ReplicaStoreCredentialState,
  type ReplicaStoreRefusalReason,
  type ReplicaStoreS3Credentials,
  type ReplicaStoreS3Settings,
  type ReplicaStoreSettings,
  type ReplicaStoreSettingsResult,
  type ReplicaStoreSettingsView,
} from "@octant/contracts/replica-store-settings";
import type { CredentialStore } from "@octant/host-runtime";
import { Schema } from "effect";
import { isInsideHomeDirectory } from "../canvas/artifactMirrorFilePort";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict } from "../persistence/journalErrors";
import type { ReplicaStoreSelection } from "./replicaMembershipService";
import {
  REPLICA_STORE_SETTINGS_AGGREGATE_ID,
  ReplicaStoreSettingsChanged,
} from "./replicaStoreSettingsEvents";
import {
  openS3ReplicaStore,
  type S3ReplicaStore,
  type S3StoreFailure,
  type S3Transport,
} from "./s3ReplicaStore";
import {
  openSyncedFolderReplicaStore,
  type SyncedFolderReplicaStore,
} from "./syncedFolderReplicaStore";

const JOURNAL_REPLAY_BATCH_SIZE = 1_000;
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeChanged = Schema.decodeUnknownSync(ReplicaStoreSettingsChanged);

type JournalPort = Pick<Journal, "append" | "replayAggregate">;

export interface ReplicaStoreSettingsServiceDependencies {
  readonly journal: JournalPort;
  readonly uuid: () => string;
  readonly actor: EventActor;
  readonly clock: () => UtcTimestamp;
  readonly home: string;
  /**
   * The standing access-outside-project grant. The host has no surface to give
   * it yet, so it is false and a folder outside home is refused.
   */
  readonly standingOutsideApproval: boolean;
  /**
   * The host credential store, reached through the credential broker. Absent
   * on a host without one, where a bucket's key pair cannot be saved.
   */
  readonly credentials: CredentialStore | undefined;
  /** The bucket store's network door. Tests pass a fake; production uses fetch. */
  readonly s3Transport?: S3Transport;
  /** Platform file flags for the folder store. Tests pass a stand-in. */
  readonly readFileFlags?: (absolutePath: string) => Promise<number>;
}

type OpenedStore =
  | { readonly kind: "synced-folder"; readonly store: SyncedFolderReplicaStore }
  | { readonly kind: "s3"; readonly store: S3ReplicaStore };

const REFUSAL_TEXT: Readonly<Record<ReplicaStoreRefusalReason, string>> = {
  malformed: "The sync settings request is malformed.",
  "stale-version": "The sync settings changed since you read them.",
  "candidate-unavailable": "That folder is no longer available to choose.",
  "outside-home": "The sync folder must be inside your home folder.",
  "credentials-required": "Enter the access key and secret for this bucket.",
  "credential-store-unavailable":
    "The access key could not be saved in this computer's credential store.",
  "not-configured": "Choose a store before turning sync on.",
};

export function replicaStoreRefusal(
  reason: ReplicaStoreRefusalReason,
): Extract<ReplicaStoreSettingsResult, { kind: "replica-store-refused" }> {
  return { kind: "replica-store-refused", reason, message: REFUSAL_TEXT[reason] };
}

export class ReplicaStoreSettingsService {
  readonly #dependencies: ReplicaStoreSettingsServiceDependencies;
  #settings: ReplicaStoreSettings;
  // Changes run one at a time: saving a key pair awaits the credential store,
  // and a second change in between would judge a version that is about to move.
  #queue: Promise<unknown> = Promise.resolve();

  constructor(dependencies: ReplicaStoreSettingsServiceDependencies) {
    this.#dependencies = dependencies;
    this.#settings = decodeReplicaStoreSettings({
      kind: "replica-store-settings",
      store: { kind: "none" },
      syncOn: false,
      version: 0,
      updatedAt: dependencies.clock(),
    });
    this.#hydrate();
  }

  settings(): ReplicaStoreSettings {
    return this.#settings;
  }

  /** What Settings › Sync shows. The credential reference stays here. */
  async view(): Promise<ReplicaStoreSettingsView> {
    const settings = this.#settings;
    const store = settings.store;
    return decodeReplicaStoreSettingsView({
      kind: "replica-store-settings-view",
      store:
        store.kind === "s3"
          ? {
              kind: "s3",
              settings: store.settings,
              credentials: await this.#credentialState(store.credentialRef),
            }
          : store,
      syncOn: settings.syncOn,
      version: settings.version,
      hostId: LOCAL_HOST_ID,
      // The folder browser records the mode a candidate was listed under;
      // sync is not a mode, and Work browses the same home folder.
      mode: "work",
      credentialStore: this.#dependencies.credentials === undefined ? "unavailable" : "available",
    });
  }

  /**
   * The store the membership service reads and writes, opened for this call.
   *
   * In-tree stores are installed; sync on is their enablement. A store that is
   * withheld - sync off - is not constructed, so it cannot be called.
   */
  selection(): ReplicaStoreSelection {
    const opened = this.#open();
    return opened === undefined
      ? { status: "not-configured" }
      : { status: "selected", store: opened.store };
  }

  /**
   * Record the folder a person chose in the host's folder browser. The path
   * arrives already resolved from a candidate the host listed.
   */
  chooseFolder(input: {
    readonly folder: string;
    readonly expectedVersion: number;
  }): Promise<ReplicaStoreSettingsResult> {
    return this.#serially(async () => {
      if (input.expectedVersion !== this.#settings.version) {
        return replicaStoreRefusal("stale-version");
      }
      if (
        !this.#dependencies.standingOutsideApproval &&
        !isInsideHomeDirectory(input.folder, this.#dependencies.home)
      ) {
        return replicaStoreRefusal("outside-home");
      }
      return this.#replaceStore({ kind: "synced-folder", folder: input.folder });
    });
  }

  /**
   * Record a bucket's settings, and save its key pair in the host credential
   * store when the person typed one. Without a new key pair, the one already
   * saved for the current bucket is kept.
   */
  configureS3(input: {
    readonly settings: ReplicaStoreS3Settings;
    readonly credentials?: ReplicaStoreS3Credentials;
    readonly expectedVersion: number;
  }): Promise<ReplicaStoreSettingsResult> {
    return this.#serially(async () => {
      if (input.expectedVersion !== this.#settings.version) {
        return replicaStoreRefusal("stale-version");
      }
      const current = this.#settings.store;
      const existingRef = current.kind === "s3" ? current.credentialRef : undefined;
      if (input.credentials === undefined) {
        if (existingRef === undefined) return replicaStoreRefusal("credentials-required");
        return this.#replaceStore({
          kind: "s3",
          settings: input.settings,
          credentialRef: existingRef,
        });
      }
      const credentials = this.#dependencies.credentials;
      if (credentials === undefined) return replicaStoreRefusal("credential-store-unavailable");
      const credentialRef = existingRef ?? this.#dependencies.uuid().toLowerCase();
      try {
        // The exact shape the bucket store reads back; anything else is read
        // as no credential rather than guessed at.
        await credentials.set(
          credentialRef,
          JSON.stringify({
            accessKeyId: input.credentials.accessKeyId,
            secretAccessKey: input.credentials.secretAccessKey,
          }),
        );
      } catch {
        return replicaStoreRefusal("credential-store-unavailable");
      }
      const result = await this.#replaceStore({
        kind: "s3",
        settings: input.settings,
        credentialRef,
      });
      if (result.kind !== "replica-store-settings-view" && existingRef === undefined) {
        // The change did not stand, so nothing refers to the key pair just saved.
        await credentials.delete(credentialRef).catch(() => undefined);
      }
      return result;
    });
  }

  /** Choose no store. Sync turns off with it. */
  clear(input: { readonly expectedVersion: number }): Promise<ReplicaStoreSettingsResult> {
    return this.#serially(async () => {
      if (input.expectedVersion !== this.#settings.version) {
        return replicaStoreRefusal("stale-version");
      }
      return this.#replaceStore({ kind: "none" });
    });
  }

  /** Turn sync on or off. On needs a store. */
  setSync(input: {
    readonly syncOn: boolean;
    readonly expectedVersion: number;
  }): Promise<ReplicaStoreSettingsResult> {
    return this.#serially(async () => {
      if (input.expectedVersion !== this.#settings.version) {
        return replicaStoreRefusal("stale-version");
      }
      if (input.syncOn && this.#settings.store.kind === "none") {
        return replicaStoreRefusal("not-configured");
      }
      if (input.syncOn === this.#settings.syncOn) return this.view();
      return this.#commit(this.#settings.store, input.syncOn);
    });
  }

  /**
   * Write one probe file to the chosen store, the way Settings' Test
   * connection asks. Nothing is deleted. With sync off no store is called.
   */
  async testConnection(): Promise<ConnectionTested> {
    if (this.#settings.store.kind === "none") {
      return connectionTested("not-configured", "Choose a store first.");
    }
    const opened = this.#open();
    if (opened === undefined) {
      return connectionTested("sync-off", "Turn sync on to test the connection.");
    }
    return opened.kind === "synced-folder" ? testFolder(opened.store) : testBucket(opened.store);
  }

  #open(): OpenedStore | undefined {
    const settings = this.#settings;
    const store = settings.store;
    if (store.kind === "none") return undefined;
    if (store.kind === "synced-folder") {
      const opened = openSyncedFolderReplicaStore({
        folder: store.folder,
        homeDirectory: this.#dependencies.home,
        outsideHomeApproved: this.#dependencies.standingOutsideApproval,
        installed: true,
        enabled: settings.syncOn,
        ...(this.#dependencies.readFileFlags === undefined
          ? {}
          : { readFileFlags: this.#dependencies.readFileFlags }),
      });
      return opened.status === "offered"
        ? { kind: "synced-folder", store: opened.store }
        : undefined;
    }
    const credentials = this.#dependencies.credentials;
    if (credentials === undefined) return undefined;
    const opened = openS3ReplicaStore({
      settings: {
        endpoint: store.settings.endpoint,
        region: store.settings.region,
        bucket: store.settings.bucket,
        ...(store.settings.prefix === undefined ? {} : { prefix: store.settings.prefix }),
        addressing: store.settings.addressing,
      },
      credentialRef: store.credentialRef,
      credentialStore: credentials,
      syncOn: settings.syncOn,
      installed: true,
      enabled: settings.syncOn,
      ...(this.#dependencies.s3Transport === undefined
        ? {}
        : { transport: this.#dependencies.s3Transport }),
    });
    return opened.status === "offered" ? { kind: "s3", store: opened.store } : undefined;
  }

  async #credentialState(credentialRef: string): Promise<ReplicaStoreCredentialState> {
    const credentials = this.#dependencies.credentials;
    if (credentials === undefined) return "unavailable";
    try {
      return (await credentials.has(credentialRef)) ? "saved" : "missing";
    } catch {
      return "unavailable";
    }
  }

  /**
   * A new or changed store leaves sync off: the storage provider can read the
   * files, and turning sync on is where the person accepts that for this
   * store. A bucket's key pair is removed from the credential store once that
   * bucket is no longer the choice.
   */
  async #replaceStore(store: ReplicaStoreChoice): Promise<ReplicaStoreSettingsResult> {
    const previous = this.#settings.store;
    const result = await this.#commit(store, false);
    if (
      result.kind === "replica-store-settings-view" &&
      previous.kind === "s3" &&
      (store.kind !== "s3" || store.credentialRef !== previous.credentialRef)
    ) {
      // Best effort: the change already stands. A credential store that
      // cannot delete now leaves an entry nothing refers to, never a key a
      // store would still use.
      await this.#dependencies.credentials?.delete(previous.credentialRef).catch(() => undefined);
    }
    return result;
  }

  async #commit(store: ReplicaStoreChoice, syncOn: boolean): Promise<ReplicaStoreSettingsResult> {
    const next = decodeReplicaStoreSettings({
      kind: "replica-store-settings",
      store,
      syncOn,
      version: decodeAggregateVersion(this.#settings.version + 1),
      updatedAt: this.#dependencies.clock(),
    });
    try {
      this.#append(next);
    } catch (error) {
      if (error instanceof ConcurrencyConflict) return replicaStoreRefusal("stale-version");
      throw error;
    }
    this.#settings = next;
    return this.view();
  }

  #append(settings: ReplicaStoreSettings): void {
    this.#dependencies.journal.append({
      aggregate: {
        aggregateType: REPLICA_STORE_SETTINGS_AGGREGATE_TYPE,
        aggregateId: REPLICA_STORE_SETTINGS_AGGREGATE_ID,
      },
      expectedVersion: this.#settings.version,
      events: [
        {
          eventId: this.#dependencies.uuid(),
          eventName: REPLICA_STORE_SETTINGS_CHANGED,
          eventVersion: 1,
          correlationId: this.#dependencies.uuid(),
          actor: this.#dependencies.actor,
          occurredAt: this.#dependencies.clock(),
          payload: { settings },
        },
      ],
    });
  }

  /** Rebuild the last stored choice from the journal, oldest frame to newest. */
  #hydrate(): void {
    let afterVersion = 0;
    let latest: ReplicaStoreSettings | undefined;
    for (;;) {
      const batch = this.#dependencies.journal.replayAggregate({
        aggregateType: REPLICA_STORE_SETTINGS_AGGREGATE_TYPE,
        aggregateId: REPLICA_STORE_SETTINGS_AGGREGATE_ID,
        afterVersion,
        limit: JOURNAL_REPLAY_BATCH_SIZE,
      });
      if (batch.length === 0) break;
      for (const envelope of batch) {
        afterVersion = envelope.aggregateVersion;
        if (envelope.eventName !== REPLICA_STORE_SETTINGS_CHANGED) continue;
        try {
          latest = decodeChanged(envelope.payload).settings;
        } catch {
          // A frame that no longer decodes is not rewritten into a store
          // nobody chose; the journal stays authoritative.
        }
      }
      if (batch.length < JOURNAL_REPLAY_BATCH_SIZE) break;
    }
    if (latest !== undefined) this.#settings = latest;
  }

  #serially<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(run);
    this.#queue = next.catch(() => undefined);
    return next;
  }
}

type ConnectionTested = Extract<
  ReplicaStoreSettingsResult,
  { kind: "replica-store-connection-tested" }
>;

function connectionTested(
  outcome: ReplicaStoreConnectionOutcome,
  message: string,
): ConnectionTested {
  return { kind: "replica-store-connection-tested", outcome, message };
}

async function testFolder(store: SyncedFolderReplicaStore): Promise<ConnectionTested> {
  const result = await store.testConnection();
  switch (result.status) {
    case "reachable":
      return connectionTested("reachable", "Octant wrote a probe file in the folder.");
    case "not-connected":
      return connectionTested("not-connected", "The folder is missing or is not a folder.");
    case "refused":
      return connectionTested(
        "refused",
        "Octant cannot write there: the folder is outside your home folder or reached through a link.",
      );
    case "failed":
      return connectionTested("write-failed", "The probe file could not be written.");
  }
}

const S3_FAILURE_TEXT: Readonly<Record<S3StoreFailure, string>> = {
  unauthorized: "The bucket refused the access key.",
  "not-found": "The bucket was not found at this endpoint.",
  throttled: "The provider asked Octant to slow down. Try again shortly.",
  unreachable: "Octant could not reach the endpoint.",
};

async function testBucket(store: S3ReplicaStore): Promise<ConnectionTested> {
  // The bucket store's own status separates a refused configuration from an
  // access key it cannot read; its probe reports both as not connected.
  const status = await store.status();
  if (status === "refused") {
    return connectionTested("refused", "Octant refused these bucket settings.");
  }
  if (status === "not-connected") {
    return connectionTested(
      "not-connected",
      "Octant could not read the access key for this bucket.",
    );
  }
  const result = await store.testConnection();
  if (result.status === "reachable") {
    return connectionTested("reachable", "Octant wrote a probe file in the bucket.");
  }
  if (result.status === "not-connected") {
    return connectionTested(
      "not-connected",
      "Octant could not read the access key for this bucket.",
    );
  }
  return connectionTested(result.reason, S3_FAILURE_TEXT[result.reason]);
}
