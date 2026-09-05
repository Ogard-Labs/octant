import {
  NATIVE_HARNESS_ROUTING_EVENT_NAMES,
  NATIVE_HARNESS_SESSION_EVENT_NAMES,
  NativeHarnessAdvisorIntervention,
  NativeHarnessContextReduction,
  NativeHarnessFollowUpCreation,
  NativeHarnessFollowUpId,
  NativeHarnessFollowUpSet,
  NativeHarnessProjectRoutingOverride,
  NativeHarnessRouteDecision,
  NativeHarnessRoutingSettings,
  NativeHarnessSession,
  NativeHarnessSessionId,
  NativeHarnessTurnRecord,
  ProjectId,
  AggregateVersion,
} from "@octant/contracts";
import { Schema } from "effect";
import type { EventRegistry } from "../persistence/eventRegistry";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const NativeHarnessProjectRoutingOverrideCleared = Schema.Struct({
  projectId: ProjectId,
  version: AggregateVersion,
}).annotations(strict);

export const NativeHarnessRouteDecided = Schema.Struct({
  sessionId: NativeHarnessSessionId,
  decision: NativeHarnessRouteDecision,
}).annotations(strict);

export const NativeHarnessFollowUpActivated = Schema.Struct({
  sessionId: NativeHarnessSessionId,
  suggestionId: NativeHarnessFollowUpId,
  created: NativeHarnessFollowUpCreation,
}).annotations(strict);

export const NativeHarnessSessionPaused = Schema.Struct({
  sessionId: NativeHarnessSessionId,
  status: Schema.Literal("paused-by-advisor", "paused-by-user", "budget-limited", "failed"),
  detail: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
}).annotations(strict);

export const NativeHarnessSessionResumed = Schema.Struct({
  sessionId: NativeHarnessSessionId,
}).annotations(strict);

/**
 * The journal frames the harness writes. Routing configuration and every
 * routing decision are frames, so a model switch is never silent; so are the
 * advisor's interventions, the follow-ups a turn suggested, and each context
 * reduction with the cache cost it paid.
 */
export function registerNativeHarnessEvents(registry: EventRegistry): EventRegistry {
  return registry
    .register(NATIVE_HARNESS_ROUTING_EVENT_NAMES.settingsUpdated, 1, NativeHarnessRoutingSettings)
    .register(
      NATIVE_HARNESS_ROUTING_EVENT_NAMES.projectOverrideSet,
      1,
      NativeHarnessProjectRoutingOverride,
    )
    .register(
      NATIVE_HARNESS_ROUTING_EVENT_NAMES.projectOverrideCleared,
      1,
      NativeHarnessProjectRoutingOverrideCleared,
    )
    .register(NATIVE_HARNESS_SESSION_EVENT_NAMES.started, 1, NativeHarnessSession)
    .register(NATIVE_HARNESS_SESSION_EVENT_NAMES.turnCompleted, 1, NativeHarnessTurnRecord)
    .register(NATIVE_HARNESS_SESSION_EVENT_NAMES.routeDecided, 1, NativeHarnessRouteDecided)
    .register(NATIVE_HARNESS_SESSION_EVENT_NAMES.contextReduced, 1, NativeHarnessContextReduction)
    .register(
      NATIVE_HARNESS_SESSION_EVENT_NAMES.advisorIntervened,
      1,
      NativeHarnessAdvisorIntervention,
    )
    .register(NATIVE_HARNESS_SESSION_EVENT_NAMES.followUpsSuggested, 1, NativeHarnessFollowUpSet)
    .register(
      NATIVE_HARNESS_SESSION_EVENT_NAMES.followUpActivated,
      1,
      NativeHarnessFollowUpActivated,
    )
    .register(NATIVE_HARNESS_SESSION_EVENT_NAMES.paused, 1, NativeHarnessSessionPaused)
    .register(NATIVE_HARNESS_SESSION_EVENT_NAMES.resumed, 1, NativeHarnessSessionResumed);
}
