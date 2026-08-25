import { Schema } from "effect";
import { HostId } from "./host";

const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
const namedString = <B extends string>(brand: B) =>
  Schema.NonEmptyTrimmedString.pipe(Schema.brand(brand));

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
  Schema.nonNegative(),
  Schema.brand("AggregateVersion"),
);
export type AggregateVersion = typeof AggregateVersion.Type;
export const EventVersion = Schema.Int.pipe(Schema.positive(), Schema.brand("EventVersion"));
export type EventVersion = typeof EventVersion.Type;
export const GlobalSequence = Schema.Int.pipe(Schema.nonNegative(), Schema.brand("GlobalSequence"));
export type GlobalSequence = typeof GlobalSequence.Type;

export const UtcTimestamp = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  Schema.filter((value) => {
    const timestamp = new Date(value);
    return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
  }),
  Schema.brand("UtcTimestamp"),
);
export type UtcTimestamp = typeof UtcTimestamp.Type;

export const decodeUtcTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

/**
 * Brand-compatible with `DeviceId` / `ProviderInstanceId` from sibling contract
 * modules. Defined here (same brand strings) so `events` does not import those
 * modules and create a circular dependency.
 */
export const EventActorDeviceId = Schema.UUID.pipe(Schema.brand("DeviceId"));
export type EventActorDeviceId = typeof EventActorDeviceId.Type;
export const EventActorProviderInstanceId = Schema.UUID.pipe(Schema.brand("ProviderInstanceId"));
export type EventActorProviderInstanceId = typeof EventActorProviderInstanceId.Type;
export const EventActorThreadId = Schema.UUID.pipe(Schema.brand("EventActorThreadId"));
export type EventActorThreadId = typeof EventActorThreadId.Type;

const actorStrict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * Versioned journal actor attribution. Additive: persisted `system` /
 * `local-user` envelopes keep decoding. `remote-device` and `agent` carry the
 * identity fields required so a remote approval is never indistinguishable from
 * a local one and agent petitions name their provider instance + thread.
 */
export const EventActor = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("system"), actorId: ActorId }).annotations(actorStrict),
  Schema.Struct({ kind: Schema.Literal("local-user"), actorId: ActorId }).annotations(actorStrict),
  Schema.Struct({
    kind: Schema.Literal("remote-device"),
    actorId: ActorId,
    deviceId: EventActorDeviceId,
  }).annotations(actorStrict),
  Schema.Struct({
    kind: Schema.Literal("agent"),
    actorId: ActorId,
    providerInstanceId: EventActorProviderInstanceId,
    threadId: EventActorThreadId,
  }).annotations(actorStrict),
);
export type EventActor = typeof EventActor.Type;

export const decodeEventActor = Schema.decodeUnknownSync(EventActor);
export const encodeEventActorJson = Schema.encodeSync(EventActor);

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
}).annotations({ parseOptions: { onExcessProperty: "error" } });
export type PendingEvent = typeof PendingEvent.Type;

export const AggregateReference = Schema.Struct({
  aggregateType: AggregateType,
  aggregateId: AggregateId,
}).annotations({ parseOptions: { onExcessProperty: "error" } });
export type AggregateReference = typeof AggregateReference.Type;

export const AppendEventsRequest = Schema.Struct({
  aggregate: AggregateReference,
  expectedVersion: AggregateVersion,
  events: Schema.NonEmptyArray(PendingEvent),
}).annotations({ parseOptions: { onExcessProperty: "error" } });
export type AppendEventsRequest = typeof AppendEventsRequest.Type;

export const EventEnvelope = Schema.Struct({
  eventId: EventId,
  globalSequence: GlobalSequence.pipe(Schema.positive()),
  aggregateType: AggregateType,
  aggregateId: AggregateId,
  aggregateVersion: AggregateVersion.pipe(Schema.positive()),
  eventName: EventName,
  eventVersion: EventVersion,
  hostId: HostId,
  correlationId: CorrelationId,
  causationId: Schema.optional(CausationId),
  actor: EventActor,
  occurredAt: UtcTimestamp,
  payload: Schema.Unknown,
}).annotations({ parseOptions: { onExcessProperty: "error" } });
export type EventEnvelope = typeof EventEnvelope.Type;

export const CommittedAppend = Schema.Struct({
  events: Schema.NonEmptyArray(EventEnvelope),
  firstSequence: GlobalSequence.pipe(Schema.positive()),
  lastSequence: GlobalSequence.pipe(Schema.positive()),
  aggregateVersion: AggregateVersion.pipe(Schema.positive()),
}).annotations({ parseOptions: { onExcessProperty: "error" } });
export type CommittedAppend = typeof CommittedAppend.Type;

export const ReplayCursor = Schema.Struct({
  afterSequence: GlobalSequence,
  limit: Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(1000)),
}).annotations({ parseOptions: { onExcessProperty: "error" } });
export type ReplayCursor = typeof ReplayCursor.Type;

export const ProjectionCheckpoint = Schema.Struct({
  projectionName: Schema.NonEmptyTrimmedString,
  lastSequence: GlobalSequence,
  updatedAt: UtcTimestamp,
}).annotations({ parseOptions: { onExcessProperty: "error" } });
export type ProjectionCheckpoint = typeof ProjectionCheckpoint.Type;
