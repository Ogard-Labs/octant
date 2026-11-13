import {
  DEFAULT_COORDINATOR_ROUNDS,
  DEFAULT_COORDINATOR_STARTS_PER_HOUR,
  DEFAULT_COORDINATOR_WAKES_PER_HOUR,
  MAX_COORDINATOR_ROUNDS,
  MAX_COORDINATOR_STARTS_PER_HOUR,
  MAX_COORDINATOR_WAKES_PER_HOUR,
  type CoordinatorBounds,
  type CoordinatorWorkerLevel,
} from "@octant/contracts";

/**
 * The level a coordinator's workers start at, as the New coordinator draft
 * and Make coordinator both offer it (docs/design/coordinator-threads.md
 * § Starting workers). The first entry fixes no level.
 */
export const COORDINATOR_WORKER_LEVELS: ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly level?: CoordinatorWorkerLevel;
}> = [
  { id: "", label: "Workers start at this thread's level or lower" },
  {
    id: "approval-gated",
    label: "Workers always start at Ask for approvals",
    level: "approval-gated",
  },
  {
    id: "auto-accept-edits",
    label: "Workers always start at Auto-accept edits",
    level: "auto-accept-edits",
  },
  { id: "full-access", label: "Workers always start at Full access", level: "full-access" },
];

/** A coordinator's three bounds, with the default and the most a person may set. */
export const COORDINATOR_BOUND_FIELDS: ReadonlyArray<{
  readonly bound: keyof CoordinatorBounds;
  readonly label: string;
  readonly default: number;
  readonly max: number;
}> = [
  {
    bound: "wakesPerHour",
    label: "Wakes an hour",
    default: DEFAULT_COORDINATOR_WAKES_PER_HOUR,
    max: MAX_COORDINATOR_WAKES_PER_HOUR,
  },
  {
    bound: "rounds",
    label: "Rounds",
    default: DEFAULT_COORDINATOR_ROUNDS,
    max: MAX_COORDINATOR_ROUNDS,
  },
  {
    bound: "startsPerHour",
    label: "Worker starts an hour",
    default: DEFAULT_COORDINATOR_STARTS_PER_HOUR,
    max: MAX_COORDINATOR_STARTS_PER_HOUR,
  },
];
