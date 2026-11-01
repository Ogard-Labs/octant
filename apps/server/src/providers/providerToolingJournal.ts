import {
  ActorId,
  CorrelationId,
  EventId,
  PROVIDER_TOOLING_APPLIED,
  UtcTimestamp,
  decodeProviderToolingAppliedRecord,
  type ProviderToolingAppliedRecord,
} from "@octant/contracts";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";

const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

/**
 * Records a change to an account's tools as its own single-event aggregate, so
 * no other writer's version waits on it. The envelope names the local user and
 * the time; the payload names the provider, account, command kind, and the
 * name the person gave, and never a value, address, argument, or secret.
 */
export function makeProviderToolingJournalRecorder(options: {
  readonly journal: Pick<Journal, "append">;
  readonly actorId: string;
  readonly uuid: () => string;
  readonly clock: () => string;
}): (change: ProviderToolingAppliedRecord) => void {
  return (change) => {
    const payload = decodeProviderToolingAppliedRecord(change);
    options.journal.append({
      aggregate: { aggregateType: "provider-tooling", aggregateId: options.uuid() },
      expectedVersion: 0,
      events: [
        {
          eventId: decodeEventId(options.uuid()),
          eventName: PROVIDER_TOOLING_APPLIED,
          eventVersion: 1,
          correlationId: decodeCorrelationId(options.uuid()),
          actor: { kind: "local-user", actorId: decodeActorId(options.actorId) },
          occurredAt: decodeTimestamp(options.clock()),
          payload,
        },
      ],
    });
  };
}
