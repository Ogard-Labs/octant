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
  /** The same choice under a "Workers start at" heading, short enough for a submenu at phone width. */
  readonly menuLabel: string;
  /** The choice as one part of the New coordinator draft's settings line. */
  readonly summary: string;
  readonly level?: CoordinatorWorkerLevel;
}> = [
  {
    id: "",
    label: "Workers start at this thread's level or lower",
    menuLabel: "This thread's level or lower",
    summary: "Workers at this thread's level or lower",
  },
  {
    id: "approval-gated",
    label: "Workers always start at Ask for approvals",
    menuLabel: "Ask for approvals",
    summary: "Workers always ask for approvals",
    level: "approval-gated",
  },
  {
    id: "auto-accept-edits",
    label: "Workers always start at Auto-accept edits",
    menuLabel: "Auto-accept edits",
    summary: "Workers always auto-accept edits",
    level: "auto-accept-edits",
  },
  {
    id: "full-access",
    label: "Workers always start at Full access",
    menuLabel: "Full access",
    summary: "Workers always at Full access",
    level: "full-access",
  },
];

/**
 * A coordinator's three bounds, with the default and the most a person may
 * set. The labels say what each bound counts in a person's words: "Wakes an
 * hour" and "Rounds" read as jargon on the New coordinator draft, where they
 * were the first thing under the heading.
 */
export const COORDINATOR_BOUND_FIELDS: ReadonlyArray<{
  readonly bound: keyof CoordinatorBounds;
  readonly label: string;
  /** One line under the label saying what the number limits. */
  readonly detail: string;
  /** The value as one part of the New coordinator draft's settings line. */
  readonly summary: (value: number) => string;
  readonly default: number;
  readonly max: number;
}> = [
  {
    bound: "wakesPerHour",
    label: "Check-ins an hour",
    detail: "How often news from its workers may wake it, or them",
    summary: (value) => `${String(value)} check-ins an hour`,
    default: DEFAULT_COORDINATOR_WAKES_PER_HOUR,
    max: MAX_COORDINATOR_WAKES_PER_HOUR,
  },
  {
    bound: "rounds",
    label: "Back-and-forths",
    detail: "Replies in a row with one worker before they wait for you",
    summary: (value) => `${String(value)} back-and-forths`,
    default: DEFAULT_COORDINATOR_ROUNDS,
    max: MAX_COORDINATOR_ROUNDS,
  },
  {
    bound: "startsPerHour",
    label: "New workers an hour",
    detail: "Workers it may start or propose in an hour",
    summary: (value) => `${String(value)} new workers an hour`,
    default: DEFAULT_COORDINATOR_STARTS_PER_HOUR,
    max: MAX_COORDINATOR_STARTS_PER_HOUR,
  },
];
