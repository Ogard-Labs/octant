import { Schema } from "effect";
import { NonNegativeInt } from "./schemaPrimitives";
import { UtcTimestamp } from "./events";

const text = (maximum: number) =>
  Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(maximum));
const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const count = NonNegativeInt;

/**
 * The webhook source a spoke contributes for its own endpoints. A routine names
 * one endpoint in the filter `endpoint`; deliveries arrive as events whose data
 * is the sender's payload, framed as outside content like any event's.
 */
export const AUTOMATION_WEBHOOK_INTEGRATION_ID = "octant.webhooks";
export const AUTOMATION_WEBHOOK_SOURCE_ID = "endpoint";
export const AUTOMATION_WEBHOOK_ENDPOINT_FILTER = "endpoint";

export const AutomationIntegrationEventTrigger = Schema.Struct({
  kind: Schema.Literal("integration-event"),
  integrationId: text(256),
  sourceId: text(256),
  filters: Schema.Record(text(64), Schema.String.check(Schema.isMaxLength(256))).check(
    Schema.makeFilter((filters) => Object.keys(filters).length <= 16),
  ),
  sourceIdentity: Schema.optional(digest),
  sourceLabel: Schema.optional(text(256)),
  pollMinutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 })),
  automaticStartLimit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })),
});
export type AutomationIntegrationEventTrigger = typeof AutomationIntegrationEventTrigger.Type;

export const AutomationIntegrationEvent = Schema.Struct({
  id: text(256),
  label: text(256),
  occurredAt: UtcTimestamp,
  url: Schema.optional(text(512).check(Schema.isPattern(/^https:\/\//))),
  data: Schema.String.check(Schema.isMaxLength(2048)),
  /** A source's own attribution, never inferred from arbitrary event text. */
  routineOutput: Schema.Boolean,
});
export type AutomationIntegrationEvent = typeof AutomationIntegrationEvent.Type;

/** Coverage receipt before a source applies event filters; identifiers carry no event bodies. */
export const AutomationEventSourceWindow = Schema.Struct({
  ids: Schema.Array(text(256)).check(Schema.isMaxLength(256)),
  atLimit: Schema.Boolean,
}).check(
  Schema.makeFilter(
    (window) =>
      new Set(window.ids).size === window.ids.length && (!window.atLimit || window.ids.length > 0),
  ),
);
export type AutomationEventSourceWindow = typeof AutomationEventSourceWindow.Type;

export const AutomationEventSourceCheckpoint = Schema.Struct({
  sourceIdentity: digest,
  observationRevision: count,
  automaticStarts: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 32 })),
  baselineReady: Schema.Boolean,
  seen: Schema.Array(text(256)).check(Schema.isMaxLength(256)),
  pending: Schema.Array(AutomationIntegrationEvent).check(Schema.isMaxLength(32)),
  /** Last complete source observation; failed attempts do not advance coverage. */
  observedAt: UtcTimestamp,
  observedWindow: Schema.optional(Schema.Array(text(256)).check(Schema.isMaxLength(256))),
  phase: Schema.Literals(["arming", "watching", "held", "unavailable", "needs-rearm"]),
  reason: Schema.optional(
    Schema.Literals([
      "source-unavailable",
      "source-changed",
      "source-limit",
      "routine-output",
      "busy-input",
      "automatic-start-limit",
      "activity-history-limit",
    ]),
  ),
  coverageGap: Schema.Boolean,
}).check(
  Schema.makeFilter(
    (checkpoint) =>
      new Set(checkpoint.seen).size === checkpoint.seen.length &&
      new Set(checkpoint.pending.map((event) => event.id)).size === checkpoint.pending.length &&
      new Set(checkpoint.observedWindow ?? []).size === (checkpoint.observedWindow?.length ?? 0),
  ),
);
export type AutomationEventSourceCheckpoint = typeof AutomationEventSourceCheckpoint.Type;

export const AutomationIntegrationEventReceipt = Schema.Struct({
  checkpoint: AutomationEventSourceCheckpoint,
  event: AutomationIntegrationEvent,
});
export type AutomationIntegrationEventReceipt = typeof AutomationIntegrationEventReceipt.Type;

export const AutomationEventSourceFieldOption = Schema.Struct({
  value: text(128),
  label: text(128),
});
export type AutomationEventSourceFieldOption = typeof AutomationEventSourceFieldOption.Type;

export const AutomationEventSourceField = Schema.Struct({
  id: text(64),
  label: text(128),
  required: Schema.Boolean,
  placeholder: Schema.optional(text(128)),
  options: Schema.optional(
    Schema.Array(AutomationEventSourceFieldOption).check(Schema.isMaxLength(100)),
  ),
});
export const AutomationEventSourceChoice = Schema.Struct({
  integrationId: text(256),
  sourceId: text(256),
  label: text(256),
  fields: Schema.Array(AutomationEventSourceField).check(Schema.isMaxLength(16)),
});
export type AutomationEventSourceChoice = typeof AutomationEventSourceChoice.Type;
export const AutomationEventSourceChoices = Schema.Array(AutomationEventSourceChoice).check(
  Schema.isMaxLength(64),
);
