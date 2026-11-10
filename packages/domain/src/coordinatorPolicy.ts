import {
  DEFAULT_COORDINATOR_OPEN_WORKER_LIMIT,
  MAX_COORDINATORS_PER_PROJECT,
  MAX_COORDINATOR_STARTS_PER_HOUR,
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

/** A message or state notice at this many hops or more is carried but wakes nothing. */
export const MAX_WAKE_HOPS = 3;
/** At most this many wake turns per thread in any hour. */
export const MAX_WAKE_TURNS_PER_HOUR = 6;

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
 * at which guardrail level. A worker's level is the one named, else the
 * coordinator's, never higher than the coordinator's, and never Full access
 * from a marked coordinator: the mark asks for confirmation on risky actions,
 * and Full access would switch that confirmation off at the start.
 */
export function decideCoordinatorStart(input: {
  readonly caller:
    | {
        readonly coordinator: boolean;
        readonly lifecycle: string;
        readonly level: ProviderExecutionPolicy;
        readonly marked: boolean;
      }
    | undefined;
  readonly profileAllowsStart: boolean;
  readonly starting: CoordinatorStartingChoice;
  readonly openWorkers: number;
  readonly openWorkerLimit: number | undefined;
  readonly startsInLastHour: number;
  readonly requestedLevel: WorkerLevel | undefined;
}): CoordinatorStartDecision {
  const caller = input.caller;
  if (caller === undefined || caller.lifecycle === "archived" || !caller.coordinator) {
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
  if (input.startsInLastHour >= MAX_COORDINATOR_STARTS_PER_HOUR) {
    return {
      status: "refused",
      reason: "rate-limited",
      message: `A coordinator may start at most ${String(MAX_COORDINATOR_STARTS_PER_HOUR)} workers in an hour.`,
    };
  }
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
  return {
    status: input.starting === "propose-for-approval" ? "propose" : "start",
    level,
  };
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
}): MessageWakeDecision {
  const fromOwnCoordinator =
    input.recipient.coordinatorThreadId !== undefined &&
    input.recipient.coordinatorThreadId === input.senderThreadId &&
    !input.recipient.coordinatorWakeOff;
  if (!input.recipient.messageWake && !fromOwnCoordinator) {
    return { status: "carry", reason: "switch-off" };
  }
  if (input.hop >= MAX_WAKE_HOPS) return { status: "carry", reason: "hops" };
  if (input.wakeTurnRunning) return { status: "carry", reason: "running" };
  if (input.wakeTurnsInLastHour >= MAX_WAKE_TURNS_PER_HOUR) {
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
