import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { ContextSubjectRef } from "./context";
import { UtcTimestamp } from "./events";
import {
  PermissionMode,
  ProviderCapabilitySupport,
  ProviderInstanceId,
  ProviderModelId,
  ProviderReadiness,
} from "./providers";

const label = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256));
export const TaskAccessSubject = ContextSubjectRef.check(
  Schema.makeFilter(
    (subject) => subject.aggregateType === "code-thread" || subject.aggregateType === "work-thread",
  ),
);

/** A read on the existing context-inspect path, with no context plan required. */
export const TaskAccessQuery = Schema.Struct({
  subject: TaskAccessSubject,
  view: Schema.Literal("task-access"),
});

export const TaskAccessRecovery = Schema.Literals([
  "provider-settings",
  "access-settings",
  "host-owner",
  "none",
]);
export type TaskAccessRecovery = typeof TaskAccessRecovery.Type;

export const BrowserAgentAvailability = Schema.Union([
  Schema.Struct({ status: Schema.Literal("unknown") }),
  Schema.Struct({ status: Schema.Literal("available"), readOnly: Schema.Boolean }),
  Schema.Struct({
    status: Schema.Literal("omitted"),
    reason: Schema.Literals([
      "no-tool-transport",
      "excluded-by-thread-constraints",
      "host-lends-no-browser",
    ]),
  }),
]);
export type BrowserAgentAvailability = typeof BrowserAgentAvailability.Type;

/** Host facts describe a read; they are never a grant or a promise about a later call. */
export const TaskAccessSnapshot = Schema.Struct({
  kind: Schema.Literal("task-access"),
  browser: Schema.optional(BrowserAgentAvailability),
  subject: TaskAccessSubject,
  observedAt: UtcTimestamp,
  selectedMode: PermissionMode,
  standing: Schema.Literals(["active", "inactive", "completed"]),
  effectiveMode: Schema.optional(PermissionMode),
  effectiveContext: Schema.Literals(["thread", "running-turn-or-session", "unknown"]),
  ceiling: Schema.optional(PermissionMode),
  default: Schema.Union([
    Schema.Struct({
      status: Schema.Literal("known"),
      mode: PermissionMode,
      scope: Schema.Literals(["project", "global"]),
      matchesSelected: Schema.Boolean,
    }),
    Schema.Struct({ status: Schema.Literal("unknown") }),
  ]),
  reviewer: Schema.Struct({
    kind: Schema.Literals(["person", "provider", "octant-shield", "none", "unknown"]),
    accountId: Schema.optional(ProviderInstanceId),
    accountName: Schema.optional(label),
    modelId: Schema.optional(ProviderModelId.check(Schema.isMaxLength(1024))),
    availability: Schema.Literals(["available", "unavailable", "unknown", "not-applicable"]),
  }),
  runtime: Schema.Struct({
    accountId: ProviderInstanceId,
    modelId: ProviderModelId.check(Schema.isMaxLength(1024)),
    accountName: Schema.optional(label),
    enabled: Schema.optional(Schema.Boolean),
    readiness: Schema.optional(ProviderReadiness),
    observedAt: Schema.optional(UtcTimestamp),
    capabilities: Schema.Array(
      Schema.Struct({
        id: Schema.Literals([
          "approvals",
          "appManagedTools",
          "nativeWebResearch",
          "nativeChildAgents",
          "forceStop",
        ]),
        // `mixed` is reported for Octant's tools alone: offered at Full
        // access beside tools the runtime loaded that Octant did not supply.
        support: Schema.Union([ProviderCapabilitySupport, Schema.Literal("mixed")]),
      }),
    ).check(Schema.isMaxLength(5)),
  }),
  outsideContent: Schema.Struct({
    read: Schema.Boolean,
    effect: Schema.Literals(["gates", "recorded", "unknown"]),
  }),
  limitations: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals([
        "disabled",
        "unavailable",
        "unsupported",
        "needs-approval",
        "unknown",
        "read-only",
        "limited",
      ]),
      message: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
      recovery: TaskAccessRecovery,
    }),
  ).check(Schema.isMaxLength(12)),
});
export type TaskAccessSnapshot = typeof TaskAccessSnapshot.Type;
export const decodeTaskAccessQuery = Schema.decodeUnknownSync(
  TaskAccessQuery,
  STRICT_DECODE_OPTIONS,
);
export const decodeTaskAccessSnapshot = Schema.decodeUnknownSync(
  TaskAccessSnapshot,
  STRICT_DECODE_OPTIONS,
);
