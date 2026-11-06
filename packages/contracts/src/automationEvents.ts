import { Schema } from "effect";
import { UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const text = (maximum: number) => Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(maximum));
const digest = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/));
const count = Schema.Int.pipe(Schema.nonNegative());

export const AutomationIntegrationEventTrigger = Schema.Struct({
  kind: Schema.Literal("integration-event"),
  integrationId: text(256),
  sourceId: text(256),
  filters: Schema.Record({ key: text(64), value: Schema.String.pipe(Schema.maxLength(256)) }).pipe(
    Schema.filter((filters) => Object.keys(filters).length <= 16),
  ),
  sourceIdentity: Schema.optional(digest),
  sourceLabel: Schema.optional(text(256)),
  pollMinutes: Schema.Int.pipe(Schema.between(1, 60)),
  automaticStartLimit: Schema.Int.pipe(Schema.between(1, 32)),
}).annotations(strict);
export type AutomationIntegrationEventTrigger = typeof AutomationIntegrationEventTrigger.Type;

export const AutomationIntegrationEvent = Schema.Struct({
  id: text(256),
  label: text(256),
  occurredAt: UtcTimestamp,
  url: Schema.optional(text(512).pipe(Schema.pattern(/^https:\/\//))),
  data: Schema.String.pipe(Schema.maxLength(2048)),
  /** A source's own attribution, never inferred from arbitrary event text. */
  routineOutput: Schema.Boolean,
}).annotations(strict);
export type AutomationIntegrationEvent = typeof AutomationIntegrationEvent.Type;

export const AutomationEventSourceCheckpoint = Schema.Struct({
  sourceIdentity: digest,
  observationRevision: count,
  automaticStarts: Schema.Int.pipe(Schema.between(0, 32)),
  baselineReady: Schema.Boolean,
  seen: Schema.Array(text(256)).pipe(Schema.maxItems(256)),
  pending: Schema.Array(AutomationIntegrationEvent).pipe(Schema.maxItems(32)),
  observedAt: UtcTimestamp,
  phase: Schema.Literal("arming", "watching", "held", "unavailable", "needs-rearm"),
  reason: Schema.optional(
    Schema.Literal(
      "source-unavailable",
      "source-changed",
      "source-limit",
      "routine-output",
      "busy-input",
      "automatic-start-limit",
      "activity-history-limit",
    ),
  ),
  coverageGap: Schema.Boolean,
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (checkpoint) =>
        new Set(checkpoint.seen).size === checkpoint.seen.length &&
        new Set(checkpoint.pending.map((event) => event.id)).size === checkpoint.pending.length,
    ),
  );
export type AutomationEventSourceCheckpoint = typeof AutomationEventSourceCheckpoint.Type;

export const AutomationIntegrationEventReceipt = Schema.Struct({
  checkpoint: AutomationEventSourceCheckpoint,
  event: AutomationIntegrationEvent,
}).annotations(strict);
export type AutomationIntegrationEventReceipt = typeof AutomationIntegrationEventReceipt.Type;

export const AutomationEventSourceField = Schema.Struct({
  id: text(64),
  label: text(128),
  required: Schema.Boolean,
  placeholder: Schema.optional(text(128)),
}).annotations(strict);
export const AutomationEventSourceChoice = Schema.Struct({
  integrationId: text(256),
  sourceId: text(256),
  label: text(256),
  fields: Schema.Array(AutomationEventSourceField).pipe(Schema.maxItems(16)),
}).annotations(strict);
export type AutomationEventSourceChoice = typeof AutomationEventSourceChoice.Type;
export const AutomationEventSourceChoices = Schema.Array(AutomationEventSourceChoice).pipe(
  Schema.maxItems(64),
);
