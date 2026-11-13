import { Schema } from "effect";
import { ProjectId } from "./projects";

/**
 * Coordinator threads (docs/design/coordinator-threads.md): the start
 * setting, its bounds, and the `start` operation of `octant_threads`.
 */

/** Settings › Code › Coordinators › Starting workers. */
export const CoordinatorStartingChoice = Schema.Literal(
  "start-without-asking",
  "propose-for-approval",
);
export type CoordinatorStartingChoice = typeof CoordinatorStartingChoice.Type;

/** At most this many Projects may carry their own Starting workers choice. */
export const MAX_COORDINATOR_PROJECT_OVERRIDES = 256;

/** Per-Project overrides; a Project not listed uses Settings. */
export const CoordinatorStartingByProject = Schema.Record({
  key: ProjectId,
  value: CoordinatorStartingChoice,
}).pipe(
  Schema.filter((entries) => Object.keys(entries).length <= MAX_COORDINATOR_PROJECT_OVERRIDES, {
    message: () => "Too many Project overrides.",
  }),
);
export type CoordinatorStartingByProject = typeof CoordinatorStartingByProject.Type;

export const DEFAULT_COORDINATOR_OPEN_WORKER_LIMIT = 6;
export const MAX_COORDINATOR_OPEN_WORKER_LIMIT = 16;
export const MAX_COORDINATORS_PER_PROJECT = 4;

/**
 * A coordinator's hourly and round bounds when the person set none
 * (docs/design/coordinator-threads.md, Bounds and Talking to workers).
 */
export const DEFAULT_COORDINATOR_WAKES_PER_HOUR = 30;
export const DEFAULT_COORDINATOR_ROUNDS = 10;
export const DEFAULT_COORDINATOR_STARTS_PER_HOUR = 60;
/**
 * The most a person may set. These bounds are what stops two agents waking
 * each other without end and a coordinator filling a Project with threads, so
 * each keeps a finite top.
 */
export const MAX_COORDINATOR_WAKES_PER_HOUR = 600;
export const MAX_COORDINATOR_ROUNDS = 100;
export const MAX_COORDINATOR_STARTS_PER_HOUR = 600;

/**
 * One coordinator's bounds as a person set them at a local window. A field
 * left out uses its default, and so does every coordinator journaled before
 * these fields existed.
 */
export const CoordinatorBounds = Schema.Struct({
  /** Wake turns per thread in any hour, for the coordinator and its workers. */
  wakesPerHour: Schema.optional(Schema.Int.pipe(Schema.between(1, MAX_COORDINATOR_WAKES_PER_HOUR))),
  /** Rounds of agents answering each other before a message stops waking. */
  rounds: Schema.optional(Schema.Int.pipe(Schema.between(1, MAX_COORDINATOR_ROUNDS))),
  /** `start` calls in any hour, admitted or proposed. */
  startsPerHour: Schema.optional(
    Schema.Int.pipe(Schema.between(1, MAX_COORDINATOR_STARTS_PER_HOUR)),
  ),
}).annotations({ parseOptions: { onExcessProperty: "error" } });
export type CoordinatorBounds = typeof CoordinatorBounds.Type;

/** The level a person may fix for every worker a coordinator starts. */
export const CoordinatorWorkerLevel = Schema.Literal(
  "approval-gated",
  "auto-accept-edits",
  "full-access",
);
export type CoordinatorWorkerLevel = typeof CoordinatorWorkerLevel.Type;

/** How many open workers one coordinator may have, set by a person. */
export const CoordinatorOpenWorkerLimit = Schema.Int.pipe(
  Schema.between(1, MAX_COORDINATOR_OPEN_WORKER_LIMIT),
);
export type CoordinatorOpenWorkerLimit = typeof CoordinatorOpenWorkerLimit.Type;

/** The profile allowlist entry for `start`; see `THREADS_TOOL_SEND_ALLOWLIST_ENTRY`. */
export const THREADS_TOOL_START_ALLOWLIST_ENTRY = "octant_threads.start";

export const MAX_COORDINATOR_WORKER_TITLE_LENGTH = 80;
export const MAX_COORDINATOR_WORKER_PROMPT_LENGTH = 4_000;

/** What a coordinator's agent passes to `start`; the host supplies everything else. */
export const CoordinatorStartInput = Schema.Struct({
  operation: Schema.Literal("start"),
  title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(MAX_COORDINATOR_WORKER_TITLE_LENGTH)),
  prompt: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(MAX_COORDINATOR_WORKER_PROMPT_LENGTH)),
  providerInstanceId: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128))),
  modelId: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256))),
  level: Schema.optional(Schema.Literal("approval-gated", "auto-accept-edits", "full-access")),
}).annotations({ parseOptions: { onExcessProperty: "error" } });
export type CoordinatorStartInput = typeof CoordinatorStartInput.Type;
export const decodeCoordinatorStartInput = Schema.decodeUnknownSync(CoordinatorStartInput);

/** Why a `start` call was refused; each is an answer the agent must handle. */
export const CoordinatorStartRefuseReason = Schema.Literal(
  "unauthorized",
  "policy",
  "limit-reached",
  "rate-limited",
  "provider-unavailable",
  "unavailable",
);
export type CoordinatorStartRefuseReason = typeof CoordinatorStartRefuseReason.Type;

/** The closed set of worker states a coordinator's roster and notices carry. */
export const CoordinatorWorkerState = Schema.Literal(
  "working",
  "waiting-for-person",
  "idle",
  "done",
);
export type CoordinatorWorkerState = typeof CoordinatorWorkerState.Type;
