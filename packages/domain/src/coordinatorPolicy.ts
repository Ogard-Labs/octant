import {
  DEFAULT_COORDINATOR_OPEN_WORKER_LIMIT,
  DEFAULT_COORDINATOR_ROUNDS,
  DEFAULT_COORDINATOR_STARTS_PER_HOUR,
  DEFAULT_COORDINATOR_WAKES_PER_HOUR,
  MAX_COORDINATORS_PER_PROJECT,
  type CoordinatorBounds,
  type CoordinatorStartRefuseReason,
  type CoordinatorStartingByProject,
  type CoordinatorStartingChoice,
  type CoordinatorWorkerState,
  type ProviderExecutionPolicy,
} from "@octant/contracts";
import { ACCESS_POSTURE_RANK } from "./codePolicy";

/**
 * Pure policy for coordinator threads (docs/design/coordinator-threads.md)
 * and the Wake when a message arrives switch. The server gathers the facts
 * and acts on the decision; nothing here reads storage or a clock.
 */

/**
 * The bounds that apply: each one the person set, else its default. A
 * coordinator journaled before the bounds were settable has none stored and
 * reads as the defaults; so does a thread no coordinator directs.
 */
export function coordinatorBoundsFor(bounds: CoordinatorBounds | undefined): {
  /** At most this many wake turns per thread in any hour. */
  readonly wakesPerHour: number;
  /** A message or state notice at this many hops or more is carried but wakes nothing. */
  readonly rounds: number;
  readonly startsPerHour: number;
} {
  return {
    wakesPerHour: bounds?.wakesPerHour ?? DEFAULT_COORDINATOR_WAKES_PER_HOUR,
    rounds: bounds?.rounds ?? DEFAULT_COORDINATOR_ROUNDS,
    startsPerHour: bounds?.startsPerHour ?? DEFAULT_COORDINATOR_STARTS_PER_HOUR,
  };
}

export interface CoordinatorRoleFacts {
  readonly lifecycle: string;
  readonly coordinator: boolean;
  /** Set on a worker; a worker is never a coordinator. */
  readonly startedByCoordinator: boolean;
  readonly projectActive: boolean;
}

export type CoordinatorRoleDecision =
  | { readonly status: "allowed" }
  | { readonly status: "unchanged" }
  | { readonly status: "refused"; readonly message: string };

/** Whether a person may make a thread a coordinator, or stop it coordinating. */
export function decideCoordinatorRole(input: {
  readonly thread: CoordinatorRoleFacts;
  readonly make: boolean;
  /** Coordinators of the thread's Project now, this thread included if it is one. */
  readonly coordinatorsInProject: number;
}): CoordinatorRoleDecision {
  if (input.make === input.thread.coordinator) return { status: "unchanged" };
  if (!input.make) return { status: "allowed" };
  if (input.thread.lifecycle === "archived") {
    return { status: "refused", message: "An archived thread cannot become a coordinator." };
  }
  if (!input.thread.projectActive) {
    return {
      status: "refused",
      message: "Only a thread of an active Code Project can coordinate.",
    };
  }
  if (input.thread.startedByCoordinator) {
    return {
      status: "refused",
      message: "A worker thread cannot become a coordinator; its coordinator directs it.",
    };
  }
  if (input.coordinatorsInProject >= MAX_COORDINATORS_PER_PROJECT) {
    return {
      status: "refused",
      message: `A Code Project may have at most ${String(MAX_COORDINATORS_PER_PROJECT)} coordinators.`,
    };
  }
  return { status: "allowed" };
}

/**
 * Whether a Code thread reads as a coordinator now. A thread holds the role
 * either on its own record or by being its Project's designated planner: the
 * planner reads as a coordinator whose starts always need approval, derived
 * from the designation so no journaled thread changes. A worker never
 * coordinates, and an archived thread directs nothing.
 */
export function readsAsCoordinator(thread: {
  readonly lifecycle: string;
  readonly coordinator: boolean;
  readonly startedByCoordinator: boolean;
  readonly designatedPlanner: boolean;
}): boolean {
  if (thread.lifecycle === "archived" || thread.startedByCoordinator) return false;
  return thread.coordinator || thread.designatedPlanner;
}

/** The Starting workers choice that applies in a Project: its override, else Settings. */
export function coordinatorStartingFor(input: {
  readonly settings: CoordinatorStartingChoice | undefined;
  readonly overrides: CoordinatorStartingByProject | undefined;
  readonly projectId: string;
}): CoordinatorStartingChoice {
  const override = input.overrides?.[input.projectId as keyof CoordinatorStartingByProject];
  return override ?? input.settings ?? "start-without-asking";
}

export type WorkerLevel = Exclude<ProviderExecutionPolicy, "plan">;

export type CoordinatorStartDecision =
  | {
      readonly status: "start" | "propose";
      readonly level: WorkerLevel;
    }
  | {
      readonly status: "refused";
      readonly reason: CoordinatorStartRefuseReason;
      readonly message: string;
    };

/**
 * Whether one `start` call may create a worker, or becomes a proposal, and
 * at which guardrail level. Where the person fixed the workers' level, every
 * worker starts at it, whatever the call names and whether or not the
 * coordinator is marked: a coordinator is marked as soon as it reads a worker,
 * and the level is the person's own choice. Otherwise a worker's level is the
 * one named, else the coordinator's, never higher than the coordinator's, and
 * never Full access from a marked coordinator: the mark asks for confirmation
 * on risky actions, and Full access would switch that confirmation off at
 * the start.
 */
export function decideCoordinatorStart(input: {
  readonly caller:
    | {
        readonly coordinator: boolean;
        readonly lifecycle: string;
        readonly level: ProviderExecutionPolicy;
        readonly marked: boolean;
        /**
         * The caller is its Project's designated planner: it reads as a
         * coordinator, and its starts always become proposals whatever the
         * start setting, as the planner's always did.
         */
        readonly designatedPlanner?: boolean;
      }
    | undefined;
  readonly profileAllowsStart: boolean;
  readonly starting: CoordinatorStartingChoice;
  readonly openWorkers: number;
  readonly openWorkerLimit: number | undefined;
  readonly startsInLastHour: number;
  /** The coordinator's bounds as a person set them; absent is the defaults. */
  readonly bounds?: CoordinatorBounds | undefined;
  readonly requestedLevel: WorkerLevel | undefined;
  /** The level a person fixed for this coordinator's workers, if any. */
  readonly fixedWorkerLevel?: WorkerLevel | undefined;
}): CoordinatorStartDecision {
  const caller = input.caller;
  if (
    caller === undefined ||
    caller.lifecycle === "archived" ||
    !(caller.coordinator || caller.designatedPlanner === true)
  ) {
    return {
      status: "refused",
      reason: "unauthorized",
      message: "Only a coordinator thread may start workers.",
    };
  }
  if (!input.profileAllowsStart) {
    return {
      status: "refused",
      reason: "policy",
      message: "This thread's profile does not permit starting worker threads.",
    };
  }
  if (caller.level === "plan") {
    return {
      status: "refused",
      reason: "policy",
      message: "A coordinator set to Plan cannot start workers.",
    };
  }
  const limit = input.openWorkerLimit ?? DEFAULT_COORDINATOR_OPEN_WORKER_LIMIT;
  if (input.openWorkers >= limit) {
    return {
      status: "refused",
      reason: "limit-reached",
      message: `This coordinator already has ${String(limit)} open workers. Wait for one to finish or be put away.`,
    };
  }
  const { startsPerHour } = coordinatorBoundsFor(input.bounds);
  if (input.startsInLastHour >= startsPerHour) {
    return {
      status: "refused",
      reason: "rate-limited",
      message: `This coordinator may start at most ${String(startsPerHour)} workers in an hour.`,
    };
  }
  const status =
    input.starting === "propose-for-approval" || caller.designatedPlanner === true
      ? "propose"
      : "start";
  if (input.fixedWorkerLevel !== undefined) return { status, level: input.fixedWorkerLevel };
  const ceiling = caller.level;
  const requested = input.requestedLevel;
  if (requested !== undefined && ACCESS_POSTURE_RANK[requested] > ACCESS_POSTURE_RANK[ceiling]) {
    return {
      status: "refused",
      reason: "policy",
      message: "A worker cannot start at a higher level than its coordinator.",
    };
  }
  if (caller.marked && requested === "full-access") {
    return {
      status: "refused",
      reason: "policy",
      message:
        "This coordinator has read outside content, so its workers cannot start at Full access.",
    };
  }
  const chosen: WorkerLevel = requested ?? ceiling;
  const level: WorkerLevel =
    caller.marked && chosen === "full-access" ? "auto-accept-edits" : chosen;
  return { status, level };
}

export interface MessageWakeRecipientFacts {
  readonly messageWake: boolean;
  readonly coordinatorThreadId: string | undefined;
  readonly coordinatorWakeOff: boolean;
  /** Active Code outside Plan, no turn running or queued, not waiting for a person. */
  readonly idle: boolean;
}

export type MessageWakeDecision =
  | { readonly status: "wake" }
  | {
      readonly status: "carry";
      readonly reason: "switch-off" | "busy" | "hops" | "running" | "hourly";
    };

/**
 * Whether an admitted message (or a coordinator's state notice) starts a
 * turn on its recipient now. A message that does not wake still waits for
 * the recipient's next turn. A worker wakes for its own coordinator without
 * its switch: turning starting on was the person's consent to that.
 */
export function decideMessageWake(input: {
  readonly recipient: MessageWakeRecipientFacts;
  readonly senderThreadId: string;
  readonly hop: number;
  readonly wakeTurnRunning: boolean;
  readonly wakeTurnsInLastHour: number;
  /**
   * The bounds of the coordinator that directs the recipient (its own when it
   * coordinates); absent is the defaults.
   */
  readonly bounds?: CoordinatorBounds | undefined;
}): MessageWakeDecision {
  const fromOwnCoordinator =
    input.recipient.coordinatorThreadId !== undefined &&
    input.recipient.coordinatorThreadId === input.senderThreadId &&
    !input.recipient.coordinatorWakeOff;
  if (!input.recipient.messageWake && !fromOwnCoordinator) {
    return { status: "carry", reason: "switch-off" };
  }
  const { rounds, wakesPerHour } = coordinatorBoundsFor(input.bounds);
  if (input.hop >= rounds) return { status: "carry", reason: "hops" };
  if (input.wakeTurnRunning) return { status: "carry", reason: "running" };
  if (input.wakeTurnsInLastHour >= wakesPerHour) {
    return { status: "carry", reason: "hourly" };
  }
  if (!input.recipient.idle) return { status: "carry", reason: "busy" };
  return { status: "wake" };
}

/**
 * Whether a worker's state change is worth a notice to its coordinator: its
 * turn ended, it started waiting for a person, or it became Done. Starting
 * to work is not, since the coordinator usually caused it.
 */
export function coordinatorNoticeFor(
  previous: CoordinatorWorkerState | undefined,
  next: CoordinatorWorkerState,
): boolean {
  if (previous === undefined || previous === next) return false;
  return next !== "working";
}
