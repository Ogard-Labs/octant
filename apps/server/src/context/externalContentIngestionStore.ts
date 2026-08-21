import {
  AggregateId,
  AggregateVersion,
  EventActor,
  EventId,
  EventName,
  MAX_CONTENT_INGESTED_PAYLOAD_BYTES,
  MAX_CONTENT_REFERENCE_LENGTH,
  MAX_CONTENT_SOURCE_LABEL_LENGTH,
  THREAD_EXTERNAL_CONTENT_AGGREGATE,
  THREAD_EXTERNAL_CONTENT_EVENT_NAMES,
  UtcTimestamp,
  decodeContentIngestedPayload,
  decodeContentProvenance,
  type ContentIngestedPayload,
  type EventActor as EventActorValue,
  type ThreadExternalContentTaint,
} from "@octant/contracts";
import { decideExternalContentIngestion } from "@octant/domain/untrusted-content-policy";
import { Schema } from "effect";
import { readAggregateVersion } from "../persistence/chatProjection";
import type { Journal } from "../persistence/journal";
import {
  ConcurrencyConflict,
  EventPayloadInvalid,
  JournalInputInvalid,
} from "../persistence/journalErrors";
import type { SqliteConnection } from "../persistence/sqlitePort";
import {
  hasThreadExternalContentReference,
  readThreadExternalContentTaint,
} from "./externalContentTaintProjection";

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

const MAX_APPEND_ATTEMPTS = 3;

export type ExternalContentIngestionResult =
  | { readonly kind: "recorded"; readonly taint: ThreadExternalContentTaint }
  | { readonly kind: "already-recorded"; readonly taint: ThreadExternalContentTaint }
  | { readonly kind: "ignored"; readonly reason: "not-tainting" }
  | {
      readonly kind: "refused";
      readonly reason: "unauthorized" | "malformed" | "oversized";
    };

export interface RecordExternalContentIngestionInput {
  readonly threadId: unknown;
  readonly provenance: unknown;
  readonly contentReference: unknown;
  readonly correlationId: unknown;
  readonly authorized: boolean;
}

export interface ExternalContentIngestionStoreOptions {
  readonly journal: Pick<Journal, "append">;
  readonly connection: SqliteConnection;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly actor: EventActorValue;
}

/**
 * Appends `thread.external-content-ingested@1` for tainting provenance.
 * Expected failures are values; the result never includes raw bodies.
 */
export class ExternalContentIngestionStore {
  readonly #journal: Pick<Journal, "append">;
  readonly #connection: SqliteConnection;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #actor: EventActorValue;
  readonly #eventName = decodeEventName(THREAD_EXTERNAL_CONTENT_EVENT_NAMES.ingested);

  constructor(options: ExternalContentIngestionStoreOptions) {
    this.#journal = options.journal;
    this.#connection = options.connection;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    this.#actor = decodeActor(options.actor);
  }

  record(input: RecordExternalContentIngestionInput): ExternalContentIngestionResult {
    if (!input.authorized) {
      return { kind: "refused", reason: "unauthorized" };
    }

    const decoded = decodeIngestionInput(input);
    if (decoded.kind === "refused") return decoded;

    const decision = decideExternalContentIngestion({
      authorized: true,
      origin: decoded.payload.provenance.origin,
      alreadyRecorded: hasThreadExternalContentReference(
        this.#connection,
        String(decoded.payload.threadId),
        decoded.payload.contentReference,
      ),
    });
    if (decision.kind === "ignore") {
      return { kind: "ignored", reason: "not-tainting" };
    }
    if (decision.kind === "already-recorded") {
      return {
        kind: "already-recorded",
        taint: readThreadExternalContentTaint(this.#connection, String(decoded.payload.threadId)),
      };
    }
    if (decision.kind === "refuse") {
      return { kind: "refused", reason: decision.reason };
    }

    return this.#append(decoded.payload);
  }

  #append(payload: ContentIngestedPayload): ExternalContentIngestionResult {
    const aggregateId = decodeAggregateId(String(payload.threadId));
    for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
      if (
        hasThreadExternalContentReference(
          this.#connection,
          String(payload.threadId),
          payload.contentReference,
        )
      ) {
        return {
          kind: "already-recorded",
          taint: readThreadExternalContentTaint(this.#connection, String(payload.threadId)),
        };
      }
      const expectedVersion = decodeAggregateVersion(
        readAggregateVersion(this.#connection, THREAD_EXTERNAL_CONTENT_AGGREGATE, aggregateId),
      );
      try {
        this.#journal.append({
          aggregate: {
            aggregateType: THREAD_EXTERNAL_CONTENT_AGGREGATE,
            aggregateId,
          },
          expectedVersion,
          events: [
            {
              eventId: decodeEventId(this.#uuid()),
              eventName: this.#eventName,
              eventVersion: 1,
              correlationId: payload.correlationId,
              actor: this.#actor,
              occurredAt: decodeTimestamp(this.#clock()),
              payload,
            },
          ],
        });
        return {
          kind: "recorded",
          taint: readThreadExternalContentTaint(this.#connection, String(payload.threadId)),
        };
      } catch (error) {
        if (error instanceof ConcurrencyConflict) continue;
        if (error instanceof JournalInputInvalid || error instanceof EventPayloadInvalid) {
          return { kind: "refused", reason: "malformed" };
        }
        throw error;
      }
    }
    return {
      kind: "already-recorded",
      taint: readThreadExternalContentTaint(this.#connection, String(payload.threadId)),
    };
  }
}

const RECORD_INPUT_KEYS = new Set([
  "threadId",
  "provenance",
  "contentReference",
  "correlationId",
  "authorized",
]);

function decodeIngestionInput(
  input: RecordExternalContentIngestionInput,
):
  | { readonly kind: "ok"; readonly payload: ContentIngestedPayload }
  | { readonly kind: "refused"; readonly reason: "malformed" | "oversized" } {
  if (Object.keys(input).some((key) => !RECORD_INPUT_KEYS.has(key))) {
    return { kind: "refused", reason: classifyOversized(input) ?? "malformed" };
  }
  const sizeReason = classifyOversized(input);
  if (sizeReason !== undefined) return { kind: "refused", reason: sizeReason };
  try {
    const provenance = decodeContentProvenance(input.provenance);
    const payload = decodeContentIngestedPayload({
      threadId: input.threadId,
      correlationId: input.correlationId,
      provenance,
      contentReference: input.contentReference,
    });
    return { kind: "ok", payload };
  } catch {
    return { kind: "refused", reason: classifyOversized(input) ?? "malformed" };
  }
}

function classifyOversized(input: RecordExternalContentIngestionInput): "oversized" | undefined {
  if (encodedByteLength(input) > MAX_CONTENT_INGESTED_PAYLOAD_BYTES) return "oversized";
  if (stringLength(input.contentReference) > MAX_CONTENT_REFERENCE_LENGTH) return "oversized";
  if (stringLength(sourceLabelOf(input.provenance)) > MAX_CONTENT_SOURCE_LABEL_LENGTH) {
    return "oversized";
  }
  return undefined;
}

function sourceLabelOf(provenance: unknown): unknown {
  if (typeof provenance !== "object" || provenance === null || !("sourceLabel" in provenance)) {
    return undefined;
  }
  return provenance.sourceLabel;
}

function stringLength(value: unknown): number {
  return typeof value === "string" ? value.length : 0;
}

function encodedByteLength(input: RecordExternalContentIngestionInput): number {
  try {
    return new TextEncoder().encode(JSON.stringify(input)).length;
  } catch {
    return MAX_CONTENT_INGESTED_PAYLOAD_BYTES + 1;
  }
}
