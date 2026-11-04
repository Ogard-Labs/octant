import { Schema } from "effect";
import { ContextSubjectRef } from "./context";
import { UtcTimestamp } from "./events";
import {
  PermissionMode,
  ProviderCapabilitySupport,
  ProviderInstanceId,
  ProviderModelId,
  ProviderReadiness,
} from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const label = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256));
export const TaskAccessSubject = ContextSubjectRef.pipe(
  Schema.filter(
    (subject) => subject.aggregateType === "code-thread" || subject.aggregateType === "work-thread",
  ),
);

/** A read on the existing context-inspect path, with no context plan required. */
export const TaskAccessQuery = Schema.Struct({
  subject: TaskAccessSubject,
  view: Schema.Literal("task-access"),
}).annotations(strict);

export const TaskAccessRecovery = Schema.Literal(
  "provider-settings",
  "access-settings",
  "host-owner",
  "none",
);
export type TaskAccessRecovery = typeof TaskAccessRecovery.Type;

/** Host facts describe a read; they are never a grant or a promise about a later call. */
export const TaskAccessSnapshot = Schema.Struct({
  kind: Schema.Literal("task-access"),
  subject: TaskAccessSubject,
  observedAt: UtcTimestamp,
  selectedMode: PermissionMode,
  standing: Schema.Literal("active", "inactive", "completed"),
  effectiveMode: Schema.optional(PermissionMode),
  effectiveContext: Schema.Literal("thread", "running-turn-or-session", "unknown"),
  ceiling: Schema.optional(PermissionMode),
  default: Schema.Union(
    Schema.Struct({
      status: Schema.Literal("known"),
      mode: PermissionMode,
      scope: Schema.Literal("project", "global"),
      matchesSelected: Schema.Boolean,
    }).annotations(strict),
    Schema.Struct({ status: Schema.Literal("unknown") }).annotations(strict),
  ),
  reviewer: Schema.Struct({
    kind: Schema.Literal("person", "provider", "octant-shield", "none", "unknown"),
    accountId: Schema.optional(ProviderInstanceId),
    accountName: Schema.optional(label),
    modelId: Schema.optional(ProviderModelId.pipe(Schema.maxLength(1024))),
    availability: Schema.Literal("available", "unavailable", "unknown", "not-applicable"),
  }).annotations(strict),
  runtime: Schema.Struct({
    accountId: ProviderInstanceId,
    modelId: ProviderModelId.pipe(Schema.maxLength(1024)),
    accountName: Schema.optional(label),
    enabled: Schema.optional(Schema.Boolean),
    readiness: Schema.optional(ProviderReadiness),
    observedAt: Schema.optional(UtcTimestamp),
    capabilities: Schema.Array(
      Schema.Struct({
        id: Schema.Literal(
          "approvals",
          "appManagedTools",
          "nativeWebResearch",
          "nativeChildAgents",
          "forceStop",
        ),
        support: ProviderCapabilitySupport,
      }).annotations(strict),
    ).pipe(Schema.maxItems(5)),
  }).annotations(strict),
  outsideContent: Schema.Struct({
    read: Schema.Boolean,
    effect: Schema.Literal("gates", "recorded", "unknown"),
  }).annotations(strict),
  limitations: Schema.Array(
    Schema.Struct({
      kind: Schema.Literal(
        "disabled",
        "unavailable",
        "unsupported",
        "needs-approval",
        "unknown",
        "read-only",
        "limited",
      ),
      message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
      recovery: TaskAccessRecovery,
    }).annotations(strict),
  ).pipe(Schema.maxItems(12)),
}).annotations(strict);
export type TaskAccessSnapshot = typeof TaskAccessSnapshot.Type;
export const decodeTaskAccessQuery = Schema.decodeUnknownSync(TaskAccessQuery);
export const decodeTaskAccessSnapshot = Schema.decodeUnknownSync(TaskAccessSnapshot);
