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

/** The kind of work a worker does; `research` goes to the coordinator's Scout, not `start`. */
export const CoordinatorWorkerTask = Schema.Literal(
  "small-fix",
  "feature",
  "ui",
  "tests",
  "docs",
  "review",
);
export type CoordinatorWorkerTask = typeof CoordinatorWorkerTask.Type;

/** How hard the work is; it picks the worker's role. */
export const CoordinatorWorkerSize = Schema.Literal("quick", "normal", "hard");
export type CoordinatorWorkerSize = typeof CoordinatorWorkerSize.Type;

/**
 * The model roles a worker may run in, as the slot ids Settings stores them
 * under: Quick edit, Builder, Hard problems and Reviewer.
 */
export const CoordinatorWorkerRole = Schema.Literal("quick", "default", "deep", "slow");
export type CoordinatorWorkerRole = typeof CoordinatorWorkerRole.Type;

/** The role names an agent writes in a `start` call, as the role card prints them. */
export const CoordinatorWorkerRoleName = Schema.Literal(
  "quick-edit",
  "builder",
  "hard-problems",
  "reviewer",
);
export type CoordinatorWorkerRoleName = typeof CoordinatorWorkerRoleName.Type;

export const MAX_COORDINATOR_START_WHY_LENGTH = 200;

/** A worker the same coordinator started, as the roster names it (`<thread>@<project>` or the thread id). */
const WorkerReference = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(160));

/** What a coordinator's agent passes to `start`; the host supplies everything else. */
export const CoordinatorStartInput = Schema.Struct({
  operation: Schema.Literal("start"),
  title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(MAX_COORDINATOR_WORKER_TITLE_LENGTH)),
  prompt: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(MAX_COORDINATOR_WORKER_PROMPT_LENGTH)),
  /**
   * A raw provider and model. Read only on a host with no roles configured;
   * with roles, the host refuses them and chooses from the roles.
   */
  providerInstanceId: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128))),
  modelId: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256))),
  level: Schema.optional(Schema.Literal("approval-gated", "auto-accept-edits", "full-access")),
  /** Required once roles are configured. */
  task: Schema.optional(CoordinatorWorkerTask),
  size: Schema.optional(CoordinatorWorkerSize),
  /** The earlier worker this one retries; it starts one tier above that worker. */
  retries: Schema.optional(WorkerReference),
  /** The worker a `review` reviews; the review prefers another provider. */
  reviews: Schema.optional(WorkerReference),
  risk: Schema.optional(Schema.Literal("high")),
  /** Overrides the role `size` picks; needs `why`. */
  role: Schema.optional(CoordinatorWorkerRoleName),
  /** A model handle from the role card (`b1`…); needs `why`. */
  model: Schema.optional(Schema.String.pipe(Schema.pattern(/^b[1-9][0-9]{0,2}$/))),
  needsImages: Schema.optional(Schema.Boolean),
  why: Schema.optional(
    Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(MAX_COORDINATOR_START_WHY_LENGTH)),
  ),
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
  /** The `model` handle named a model that is not eligible now. */
  "model-not-eligible",
  /** No model in the role, or in the roles it may borrow, is eligible now. */
  "no-eligible-model",
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

/**
 * Where in its role's list the model a worker started on sits. `main` is the
 * role's first model; `fallback` the n-th one after it; `borrowed` a model
 * of another role's list because every model of this role was unavailable;
 * `chosen` a model the coordinator named by its handle; `person` a model a
 * person picked in the proposal review.
 */
export const CoordinatorWorkerChoiceRank = Schema.Union(
  Schema.Literal("main", "chosen", "person"),
  Schema.Struct({ fallback: Schema.Int.pipe(Schema.between(1, 15)) }).annotations({
    parseOptions: { onExcessProperty: "error" },
  }),
  Schema.Struct({
    borrowed: CoordinatorWorkerRole,
    /** Set when Hard problems borrowed Builder's list: a lower tier. */
    lowerTier: Schema.optional(Schema.Literal(true)),
  }).annotations({ parseOptions: { onExcessProperty: "error" } }),
);
export type CoordinatorWorkerChoiceRank = typeof CoordinatorWorkerChoiceRank.Type;

export const MAX_COORDINATOR_CHOICE_REASON_LENGTH = 400;

/**
 * How the host chose a worker's model, journaled on the worker's own record
 * at creation (docs/design/coordinator-threads.md, Starting workers). The
 * reason is host-written from its own facts ("main at usage limit until
 * 14:00"); `why` is the coordinator's reason for an override, as it wrote it.
 * Never the prompt.
 */
export const CoordinatorWorkerChoice = Schema.Struct({
  role: CoordinatorWorkerRole,
  rank: CoordinatorWorkerChoiceRank,
  reason: Schema.optional(
    Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(MAX_COORDINATOR_CHOICE_REASON_LENGTH)),
  ),
  why: Schema.optional(
    Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(MAX_COORDINATOR_START_WHY_LENGTH)),
  ),
}).annotations({ parseOptions: { onExcessProperty: "error" } });
export type CoordinatorWorkerChoice = typeof CoordinatorWorkerChoice.Type;
