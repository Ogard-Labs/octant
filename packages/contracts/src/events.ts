import { Schema } from "effect";
import { GuidString, NonEmptyTrimmedString, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { HostId } from "./host";

const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));
const namedString = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty()), Schema.brand<B>(brand));

export const EventId = brandedUuid("EventId");
export type EventId = typeof EventId.Type;
export const AggregateId = brandedUuid("AggregateId");
export type AggregateId = typeof AggregateId.Type;
export const CorrelationId = brandedUuid("CorrelationId");
export type CorrelationId = typeof CorrelationId.Type;
export const CausationId = brandedUuid("CausationId");
export type CausationId = typeof CausationId.Type;
export const ActorId = brandedUuid("ActorId");
export type ActorId = typeof ActorId.Type;

export const AggregateType = namedString("AggregateType");
export type AggregateType = typeof AggregateType.Type;
export const EventName = namedString("EventName");
export type EventName = typeof EventName.Type;

export const AggregateVersion = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.brand("AggregateVersion"),
);
export type AggregateVersion = typeof AggregateVersion.Type;
export const EventVersion = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThan(0)),
  Schema.brand("EventVersion"),
);
export type EventVersion = typeof EventVersion.Type;
export const GlobalSequence = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.brand("GlobalSequence"),
);
export type GlobalSequence = typeof GlobalSequence.Type;

export const UtcTimestamp = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    Schema.makeFilter((value) => {
      const timestamp = new Date(value);
      return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
    }),
  ),
  Schema.brand("UtcTimestamp"),
);
export type UtcTimestamp = typeof UtcTimestamp.Type;

export const decodeUtcTimestamp = Schema.decodeUnknownSync(UtcTimestamp, STRICT_DECODE_OPTIONS);
export const decodeAggregateVersion = Schema.decodeUnknownSync(
  AggregateVersion,
  STRICT_DECODE_OPTIONS,
);

/**
 * Brand-compatible with `DeviceId` / `ProviderInstanceId` from sibling contract
 * modules. Defined here (same brand strings) so `events` does not import those
 * modules and create a circular dependency.
 */
export const EventActorDeviceId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("DeviceId"),
);
export type EventActorDeviceId = typeof EventActorDeviceId.Type;
export const EventActorProviderInstanceId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("ProviderInstanceId"),
);
export type EventActorProviderInstanceId = typeof EventActorProviderInstanceId.Type;
export const EventActorThreadId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("EventActorThreadId"),
);
export type EventActorThreadId = typeof EventActorThreadId.Type;

/**
 * Versioned journal actor attribution. Additive: persisted `system` /
 * `local-user` envelopes keep decoding. `owner-unlock` names a hub member,
 * whose identity is distinct from a local window or a paired device record.
 * `remote-device` and `agent` carry the
 * identity fields required so a remote approval is never indistinguishable from
 * a local one and agent petitions name their provider instance + thread.
 */
export const EventActor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("system"), actorId: ActorId }),
  Schema.Struct({ kind: Schema.Literal("local-user"), actorId: ActorId }),
  Schema.Struct({
    kind: Schema.Literal("owner-unlock"),
    actorId: ActorId,
    memberId: GuidString,
  }),
  Schema.Struct({
    kind: Schema.Literal("remote-device"),
    actorId: ActorId,
    deviceId: EventActorDeviceId,
  }),
  Schema.Struct({
    kind: Schema.Literal("agent"),
    actorId: ActorId,
    providerInstanceId: EventActorProviderInstanceId,
    threadId: EventActorThreadId,
  }),
]);
export type EventActor = typeof EventActor.Type;

export const decodeEventActor = Schema.decodeUnknownSync(EventActor, STRICT_DECODE_OPTIONS);

export const PendingEvent = Schema.Struct({
  eventId: EventId,
  eventName: EventName,
  eventVersion: EventVersion,
  hostId: HostId,
  correlationId: CorrelationId,
  causationId: Schema.optional(CausationId),
  actor: EventActor,
  occurredAt: UtcTimestamp,
  payload: Schema.Unknown,
});
export type PendingEvent = typeof PendingEvent.Type;

export const AggregateReference = Schema.Struct({
  aggregateType: AggregateType,
  aggregateId: AggregateId,
});
export type AggregateReference = typeof AggregateReference.Type;

export const AppendEventsRequest = Schema.Struct({
  aggregate: AggregateReference,
  expectedVersion: AggregateVersion,
  events: Schema.NonEmptyArray(PendingEvent),
});
export type AppendEventsRequest = typeof AppendEventsRequest.Type;

export const EventEnvelope = Schema.Struct({
  eventId: EventId,
  globalSequence: GlobalSequence.check(Schema.isGreaterThan(0)),
  aggregateType: AggregateType,
  aggregateId: AggregateId,
  aggregateVersion: AggregateVersion.check(Schema.isGreaterThan(0)),
  eventName: EventName,
  eventVersion: EventVersion,
  hostId: HostId,
  correlationId: CorrelationId,
  causationId: Schema.optional(CausationId),
  actor: EventActor,
  occurredAt: UtcTimestamp,
  payload: Schema.Unknown,
});
export type EventEnvelope = typeof EventEnvelope.Type;

export const CommittedAppend = Schema.Struct({
  events: Schema.NonEmptyArray(EventEnvelope),
  firstSequence: GlobalSequence.check(Schema.isGreaterThan(0)),
  lastSequence: GlobalSequence.check(Schema.isGreaterThan(0)),
  aggregateVersion: AggregateVersion.check(Schema.isGreaterThan(0)),
});
export type CommittedAppend = typeof CommittedAppend.Type;

export const ReplayCursor = Schema.Struct({
  afterSequence: GlobalSequence,
  limit: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1000)),
});
export type ReplayCursor = typeof ReplayCursor.Type;

export const ProjectionCheckpoint = Schema.Struct({
  projectionName: NonEmptyTrimmedString,
  lastSequence: GlobalSequence,
  updatedAt: UtcTimestamp,
});
export type ProjectionCheckpoint = typeof ProjectionCheckpoint.Type;
