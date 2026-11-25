import { ActorId, AggregateId, CorrelationId, EventId, LOCAL_HOST_ID } from "@octant/contracts";
import type { CredentialRequestReference } from "@octant/contracts/credential-request";
import {
  decodeThreadSecretMemoryRecord,
  THREAD_SECRET_MEMORY_AGGREGATE_TYPE,
  THREAD_SECRET_MEMORY_EVENT_NAME,
  type RememberedThreadSecret,
  type ThreadSecretMemoryRecord,
} from "@octant/contracts/thread-secrets";
import { Schema } from "effect";
import { readAggregateVersion } from "../persistence/chatProjection";
import type { Journal } from "../persistence/journal";
import type { SqliteConnection } from "../persistence/sqlitePort";
import type { ProviderCredentialStore } from "../providers/credentialBrokerClient";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";

const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);

/** One host-wide aggregate: what was remembered and forgotten reads as one history. */
const MEMORY_AGGREGATE_ID = decodeAggregateId("00000000-0000-4000-8000-0000000000c9");
const REPLAY_PAGE = 1_000;
/** A list the person reads in Settings, not a store for programs. */
const MAX_REMEMBERED = 128;

export interface ThreadSecretMemoryJournal {
  /** Throws when it cannot, so nothing is remembered unrecorded. */
  readonly record: (record: ThreadSecretMemoryRecord) => void;
  readonly history: () => ReadonlyArray<ThreadSecretMemoryRecord>;
}

type Remembered = Extract<ThreadSecretMemoryRecord, { readonly name: "thread-secret.remembered" }>;

export type RememberedValue =
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "reference"; readonly reference: CredentialRequestReference };

/**
 * The secrets a person asked Octant to remember, offered on a later card for
 * the same name and used only when the person picks one there.
 *
 * A typed value is in the system's credential store; a linked item is only its
 * address. The journal has a record before the store has a value, so a crash
 * between them leaves a name whose value is missing, never a value nothing
 * names.
 */
export class RememberedThreadSecrets {
  readonly #journal: ThreadSecretMemoryJournal;
  readonly #store: Pick<ProviderCredentialStore, "resolve" | "set" | "delete">;
  readonly #uuid: () => string;
  readonly #remembered = new Map<string, Remembered>();
  /** Writes to the store that have not landed yet. */
  readonly #storing = new Map<string, Promise<void>>();

  constructor(options: {
    readonly journal: ThreadSecretMemoryJournal;
    readonly store: Pick<ProviderCredentialStore, "resolve" | "set" | "delete">;
    readonly uuid: () => string;
  }) {
    this.#journal = options.journal;
    this.#store = options.store;
    this.#uuid = options.uuid;
    for (const record of options.journal.history()) {
      if (record.name === "thread-secret.remembered") this.#remembered.set(record.id, record);
      else this.#remembered.delete(record.id);
    }
  }

  /** Names and ids only; a name given keeps to that name. */
  list(names?: ReadonlyArray<string>): ReadonlyArray<RememberedThreadSecret> {
    return [...this.#remembered.values()]
      .filter((record) => names === undefined || names.includes(record.secretName))
      .map(({ id, secretName, source }) => ({ id, name: secretName, source }));
  }

  /** Its id, or undefined when it could not be kept; nothing is left behind then. */
  async remember(secretName: string, value: RememberedValue): Promise<string | undefined> {
    if (this.#remembered.size >= MAX_REMEMBERED && this.list([secretName]).length === 0)
      return undefined;
    const id = this.#uuid();
    const record: Remembered =
      value.kind === "value"
        ? { name: "thread-secret.remembered", id, secretName, source: "pasted" }
        : {
            name: "thread-secret.remembered",
            id,
            secretName,
            source: "onepassword",
            ...value.reference,
          };
    try {
      this.#journal.record(record);
    } catch {
      return undefined;
    }
    this.#remembered.set(id, record);
    if (value.kind === "value") {
      const storing = this.#store.set(id, value.value);
      this.#storing.set(id, storing);
      try {
        await storing;
      } catch {
        await this.forget(id);
        return undefined;
      } finally {
        this.#storing.delete(id);
      }
    }
    return id;
  }

  /**
   * Drops what a name held before this one, once it is in use. A newer one is
   * another answer's: if each dropped the other, neither would be left.
   */
  async forgetEarlier(secretName: string, keptId: string): Promise<void> {
    const ids = this.list([secretName]).map(({ id }) => id);
    for (const id of ids.slice(0, Math.max(ids.indexOf(keptId), 0))) await this.forget(id);
  }

  /** Whether nothing of it is left. A value that could not be removed keeps its name listed. */
  async forget(id: string): Promise<boolean> {
    const record = this.#remembered.get(id);
    if (record === undefined) return true;
    // A value removed before its write lands would be stored with no name.
    await this.#storing.get(id)?.catch(() => undefined);
    if (!this.#remembered.has(id)) return true;
    try {
      if (record.source === "pasted") await this.#store.delete(id);
      this.#journal.record({ name: "thread-secret.forgotten", id });
    } catch {
      return false;
    }
    this.#remembered.delete(id);
    return true;
  }

  /** What a remembered secret is now, or undefined when it is not there for this name. */
  async resolve(id: string, secretName: string): Promise<RememberedValue | undefined> {
    const record = this.#remembered.get(id);
    if (record === undefined || record.secretName !== secretName) return undefined;
    if (record.source === "onepassword")
      return {
        kind: "reference",
        reference: { store: record.store, reference: record.reference },
      };
    try {
      return { kind: "value", value: await this.#store.resolve(id) };
    } catch {
      return undefined;
    }
  }
}

export function threadSecretMemoryJournal(options: {
  readonly journal: Journal;
  readonly connection: SqliteConnection;
  readonly uuid: () => string;
  readonly now: () => string;
}): ThreadSecretMemoryJournal {
  return {
    record: (record) => {
      options.journal.append({
        aggregate: {
          aggregateType: THREAD_SECRET_MEMORY_AGGREGATE_TYPE,
          aggregateId: MEMORY_AGGREGATE_ID,
        },
        expectedVersion: readAggregateVersion(
          options.connection,
          THREAD_SECRET_MEMORY_AGGREGATE_TYPE,
          String(MEMORY_AGGREGATE_ID),
        ),
        events: [
          {
            eventId: decodeEventId(options.uuid()),
            eventName: THREAD_SECRET_MEMORY_EVENT_NAME,
            eventVersion: 1,
            hostId: LOCAL_HOST_ID,
            correlationId: decodeCorrelationId(options.uuid()),
            actor: { kind: "local-user", actorId: decodeActorId(OCTANT_LOCAL_ACTOR_ID) },
            occurredAt: options.now(),
            payload: decodeThreadSecretMemoryRecord(record),
          },
        ],
      });
    },
    history: () => {
      const records: ThreadSecretMemoryRecord[] = [];
      let afterSequence = 0;
      for (;;) {
        const page = options.journal.replayAggregateType({
          aggregateType: THREAD_SECRET_MEMORY_AGGREGATE_TYPE,
          afterSequence,
          limit: REPLAY_PAGE,
        });
        for (const event of page) {
          afterSequence = event.globalSequence;
          try {
            records.push(decodeThreadSecretMemoryRecord(event.payload));
          } catch {
            // One record this host cannot read keeps the others from nothing.
          }
        }
        if (page.length < REPLAY_PAGE) return records;
      }
    },
  };
}
