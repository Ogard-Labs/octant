import type { CoordinatorDoneWhen, CoordinatorDoneWhenItem } from "@octant/contracts";

/**
 * Pure evaluation and backoff schedule for a coordinator's host-checked
 * "done when" condition (docs/design/coordinator-threads.md). Nothing here
 * reads storage, a clock, or a forge: the server gathers closed-set host
 * facts and acts on the result without starting workers itself.
 */

/** Base interval between consecutive checks while a condition remains unmet. */
export const COORDINATOR_DONE_WHEN_INITIAL_DELAY_MS = 30_000;

/** Maximum interval between checks under exponential backoff. */
export const COORDINATOR_DONE_WHEN_MAX_DELAY_MS = 15 * 60_000;

/**
 * Closed-set pull request facts read by the host for a done-when check.
 * Never carries forge-supplied titles, comments, or check logs, so checking
 * a condition does not mark the coordinator as having read outside content.
 */
export type CoordinatorDoneWhenPullRequestFact =
  | {
      readonly status: "observed";
      readonly state: "open" | "merged" | "closed";
      /** Required checks on the pull request head; omitted when only merge state was requested. */
      readonly requiredChecks?: "green" | "pending" | "failing" | "unavailable";
    }
  | { readonly status: "unavailable" };

/** Closed-set thread Done fact read by the host within the coordinator's Project. */
export type CoordinatorDoneWhenThreadFact = "done" | "not-done" | "archived" | "missing";

export interface CoordinatorDoneWhenFacts {
  readonly pullRequests: ReadonlyMap<string, CoordinatorDoneWhenPullRequestFact>;
  readonly threads: ReadonlyMap<string, CoordinatorDoneWhenThreadFact>;
}

export type CoordinatorDoneWhenEvaluation =
  | { readonly status: "met" }
  | { readonly status: "unmet"; readonly unmet: ReadonlyArray<string> };

export type CoordinatorDoneWhenScheduleState =
  | { readonly status: "satisfied" }
  | {
      readonly status: "pending";
      readonly attempts: number;
      readonly nextCheckAt: number;
      readonly lastUnmetKey: string;
    };

/** Canonical map key for one pull request target. */
export function coordinatorDoneWhenPullRequestKey(
  repositoryOwner: string,
  repositoryName: string,
  number: number,
): string {
  return `${repositoryOwner.toLowerCase()}/${repositoryName.toLowerCase()}#${String(number)}`;
}

/** Canonical key for one done-when item, used for equality and deduplication. */
export function coordinatorDoneWhenItemKey(item: CoordinatorDoneWhenItem): string {
  return item.kind === "thread-done"
    ? `${item.kind}:${String(item.threadId)}`
    : `${item.kind}:${coordinatorDoneWhenPullRequestKey(item.repositoryOwner, item.repositoryName, item.number)}`;
}

/** Stable fingerprint of a coordinator's done-when condition. */
export function coordinatorDoneWhenKey(condition: CoordinatorDoneWhen): string {
  return condition.items.map(coordinatorDoneWhenItemKey).join("|");
}

/** Structural equality for two optional done-when conditions. */
export function coordinatorDoneWhenEqual(
  left: CoordinatorDoneWhen | undefined,
  right: CoordinatorDoneWhen | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.items.length !== right.items.length) return false;
  return left.items.every((item, index) => {
    const other = right.items[index];
    return (
      other !== undefined && coordinatorDoneWhenItemKey(item) === coordinatorDoneWhenItemKey(other)
    );
  });
}

/**
 * Evaluates every item of a coordinator's done-when condition against host
 * facts and returns either `met` or only the items that remain unmet.
 */
export function evaluateCoordinatorDoneWhen(
  condition: CoordinatorDoneWhen,
  facts: CoordinatorDoneWhenFacts,
): CoordinatorDoneWhenEvaluation {
  const unmet: string[] = [];
  for (const item of condition.items) {
    if (item.kind === "thread-done") {
      const id = String(item.threadId);
      const state = facts.threads.get(id) ?? "missing";
      if (state === "done") continue;
      if (state === "not-done") unmet.push(`thread ${id} is not Done`);
      else if (state === "archived") unmet.push(`thread ${id} is archived (not Done)`);
      else unmet.push(`thread ${id} was not found`);
      continue;
    }
    const label = `${item.repositoryOwner}/${item.repositoryName}#${String(item.number)}`;
    const fact = facts.pullRequests.get(
      coordinatorDoneWhenPullRequestKey(item.repositoryOwner, item.repositoryName, item.number),
    );
    if (item.kind === "pull-request-merged") {
      if (fact === undefined || fact.status === "unavailable") {
        unmet.push(`pull request ${label} could not be checked`);
      } else if (fact.state === "open") {
        unmet.push(`pull request ${label} is not merged (open)`);
      } else if (fact.state === "closed") {
        unmet.push(`pull request ${label} is closed without merging`);
      }
      continue;
    }
    if (
      fact === undefined ||
      fact.status === "unavailable" ||
      fact.requiredChecks === undefined ||
      fact.requiredChecks === "unavailable"
    ) {
      unmet.push(`pull request ${label} required checks could not be checked`);
    } else if (fact.requiredChecks === "pending") {
      unmet.push(`pull request ${label} required checks are pending`);
    } else if (fact.requiredChecks === "failing") {
      unmet.push(`pull request ${label} required checks are failing`);
    }
  }
  return unmet.length === 0 ? { status: "met" } : { status: "unmet", unmet };
}

/**
 * Advances a coordinator's host-check schedule after one evaluation. Stops
 * checking once the condition holds; backs off exponentially up to the cap
 * while the same items stay unmet, and resets to the initial delay when the
 * unmet items change.
 */
export function nextCoordinatorDoneWhenCheck(input: {
  readonly now: number;
  readonly previous?: Extract<CoordinatorDoneWhenScheduleState, { readonly status: "pending" }>;
  readonly evaluation: CoordinatorDoneWhenEvaluation;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
}): CoordinatorDoneWhenScheduleState {
  if (input.evaluation.status === "met") return { status: "satisfied" };
  const initialDelayMs = input.initialDelayMs ?? COORDINATOR_DONE_WHEN_INITIAL_DELAY_MS;
  const maxDelayMs = input.maxDelayMs ?? COORDINATOR_DONE_WHEN_MAX_DELAY_MS;
  const unmetKey = input.evaluation.unmet.join("\n");
  const unchanged = input.previous !== undefined && input.previous.lastUnmetKey === unmetKey;
  const attempts = unchanged ? input.previous.attempts + 1 : 1;
  const delay = Math.min(initialDelayMs * 2 ** (attempts - 1), maxDelayMs);
  return {
    status: "pending",
    attempts,
    nextCheckAt: input.now + delay,
    lastUnmetKey: unmetKey,
  };
}

/**
 * Host-written prompt for a done-when wake turn. Reports only the unmet items
 * from closed-set host facts; never starts workers itself.
 */
export function coordinatorDoneWhenWakePrompt(unmet: ReadonlyArray<string>): string {
  return [
    "Octant checked your done-when condition and these items are still unmet:",
    ...unmet.map((item) => `- ${item}`),
  ].join("\n");
}
